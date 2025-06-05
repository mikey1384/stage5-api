import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";

import paymentsRouter from "./routes/payments";
import webhookRouter from "./routes/webhook";
import creditsRouter from "./routes/credits";
import { initDatabase, createTables } from "./lib/db";

// Types for Cloudflare Workers environment
type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// Middleware
app.use("*", logger());
app.use("*", prettyJSON());

// CORS configuration
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) =>
        o.trim()
      ) || ["https://stage5.tools", "http://localhost:3000"];

      if (!origin || allowedOrigins.includes(origin)) {
        return origin || "*";
      }

      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Stripe-Signature"],
    credentials: true,
  })
);

// Health check endpoint
app.get("/", (c) => {
  return c.json({
    service: "stage5-api",
    version: "1.0.0",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime?.() || 0,
  });
});

// Routes
app.route("/payments", paymentsRouter);
app.route("/stripe/webhook", webhookRouter);
app.route("/credits", creditsRouter);

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

// Initialize database (for Cloudflare Workers)
const initializeApp = async (env?: Bindings) => {
  if (env?.DB) {
    await initDatabase({ database: env.DB });
    await createTables();
  }
};

// Export for Cloudflare Workers
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    await initializeApp(env);
    return app.fetch(request, env, ctx);
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
