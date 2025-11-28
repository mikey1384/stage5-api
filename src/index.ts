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
import { ensureDatabase } from "./lib/db";

// Types for Cloudflare Workers environment
type Bindings = {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  RELAY_SECRET: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_DEVICE_ID?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

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
    allowHeaders: ["Content-Type", "Stripe-Signature"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// Webhook first - needs raw body before any middleware consumes it
app.route("/stripe/webhook", webhookRouter);

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
  async fetch(req: Request, env: Bindings, ctx: ExecutionContext) {
    await ensureDatabase(env); // initialise D1 once
    return app.fetch(req, env, ctx);
  },
};

// Export app for other environments (Node.js, etc.)
export { app };
