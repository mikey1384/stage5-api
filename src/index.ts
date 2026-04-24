import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";

import paymentsRouter from "./routes/payments";
import webhookRouter from "./routes/webhook";
import creditsRouter from "./routes/credits";
import transcribeRouter from "./routes/transcribe";
import translateRouter from "./routes/translate";
import adminRouter from "./routes/admin";
import dubRouter from "./routes/dub";
import entitlementsRouter from "./routes/entitlements";
import authRouter from "./routes/auth";
import { ensureDatabase } from "./lib/db";
import { runReconciliation } from "./lib/reconciliation";
import { minimumTranslatorVersionGate } from "./lib/translator-version-gate";
import type { Stage5ApiBindings } from "./types/env";

export { PaymentEventsDurableObject } from "./lib/payment-events-do";

const app = new Hono<{ Bindings: Stage5ApiBindings }>();
const translatorVersionGate = minimumTranslatorVersionGate();

// Middleware that does NOT consume the body
app.use("*", logger());

// CORS configuration
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const list = (c.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s: string) => s.trim());
      return !origin || list.includes(origin) ? origin || "*" : null;
    },
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Stripe-Signature",
      "X-Relay-Secret",
      "Idempotency-Key",
      "X-Idempotency-Key",
      "X-Request-Id",
      "X-Stage5-App-Version",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: ["X-Request-Id"],
    credentials: true,
  })
);

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// Webhook first - needs raw body before any middleware consumes it
app.route("/stripe/webhook", webhookRouter);

// Translator desktop compatibility gate. Keep internal relay/webhook paths
// outside this gate. /auth/authorize performs its own version enforcement so
// it can honor the legacy body.appVersion fallback without the middleware
// rejecting the request before the route reads the JSON body.
app.use("/auth/device-token", translatorVersionGate);
app.use("/payments/create-session", translatorVersionGate);
app.use("/payments/create-byo-unlock", translatorVersionGate);
app.use("/payments/checkout-event", translatorVersionGate);
app.use("/payments/events/*", translatorVersionGate);
app.use("/payments/session/*", translatorVersionGate);
app.use("/credits/*", translatorVersionGate);
app.use("/entitlements/*", translatorVersionGate);
app.use("/transcribe", translatorVersionGate);
app.use("/transcribe/*", translatorVersionGate);
app.use("/translate", translatorVersionGate);
app.use("/translate/*", translatorVersionGate);
app.use("/dub", translatorVersionGate);
app.use("/dub/*", translatorVersionGate);

// Auth router for relay (uses X-Relay-Secret, not bearer auth)
app.route("/auth", authRouter);

// The rest of the API routes
app.route("/payments", paymentsRouter);
app.route("/credits", creditsRouter);
app.route("/entitlements", entitlementsRouter);
app.route("/transcribe", transcribeRouter);
app.route("/translate", translateRouter);
app.route("/dub", dubRouter);
app.route("/admin", adminRouter);

// Pretty printing only AFTER routes so it never eats request bodies
app.use("*", prettyJSON());

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      message: "The requested endpoint does not exist",
    },
    404
  );
});

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    },
    500
  );
});

// Export for Cloudflare Workers
export default {
  async fetch(req: Request, env: Stage5ApiBindings, ctx: ExecutionContext) {
    await ensureDatabase(env); // initialise D1 once
    return app.fetch(req, env, ctx);
  },
  async scheduled(
    _event: ScheduledController,
    env: Stage5ApiBindings,
    ctx: ExecutionContext
  ) {
    if (env.RECONCILE_CRON_ENABLED !== "1") {
      return;
    }

    await ensureDatabase(env);
    ctx.waitUntil(
      (async () => {
        try {
          const report = await runReconciliation({
            dryRun: env.RECONCILE_CRON_DRY_RUN === "1",
            transcriptionBucket: env.TRANSCRIPTION_BUCKET,
          });
          console.log(
            `[cron/reconcile] dryRun=${report.dryRun} durationMs=${report.durationMs} translation(scanned=${report.translation.scanned}, rebilled=${report.translation.rebilled}, reset=${report.translation.staleRelayReset}) transcription(scanned=${report.transcription.scanned}, failed=${report.transcription.markedFailed})`
          );
        } catch (error: any) {
          console.error("[cron/reconcile] Failed:", error?.message || error);
        }
      })()
    );
  },
};

// Export app for other environments (Node.js, etc.)
export { app };
