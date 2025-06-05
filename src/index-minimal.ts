import { Hono } from "hono";

const app = new Hono();

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
  });
});

// Export for Cloudflare Workers
export default {
  async fetch(request: Request, env: any, ctx: any) {
    return app.fetch(request, env, ctx);
  },
};

export { app };
