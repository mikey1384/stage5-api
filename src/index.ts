import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";

import paymentsRouter from "./routes/payments";
import webhookRouter from "./routes/webhook";
import creditsRouter from "./routes/credits";
import { ensureDatabase } from "./lib/db";

// Types for Cloudflare Workers environment
type Bindings = {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ALLOWED_ORIGINS?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Middleware
app.use("*", logger(), prettyJSON());

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

// Routes
app.route("/payments", paymentsRouter);
app.route("/credits", creditsRouter);
app.route("/stripe/webhook", webhookRouter);

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

// For Node.js environments (commented out until proper server is implemented)
// if (typeof process !== "undefined" && process.env.NODE_ENV !== "test") {
//   const port = parseInt(process.env.PORT || "8787");
//   console.log(`🚀 Stage5 API starting on port ${port}`);
//   console.log(`📊 Health check: http://localhost:${port}/health`);
//
//   // TODO: Add proper Node.js server with serve(app.fetch)
// }
