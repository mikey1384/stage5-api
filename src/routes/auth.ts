import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  upsertRelayTranslationJob,
  getRelayTranslationJob,
  cleanupOldRelayTranslationJobs,
} from "../lib/db";
import {
  authorizeRelayApiKey,
  deductRelayCredits,
  hasValidRelaySecret,
  RELAY_BILLING_ROUTE_SEGMENTS,
} from "../lib/relay-billing";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

// Add CORS middleware
router.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Relay-Secret"],
  })
);

// All routes in this file use X-Relay-Secret (not bearer auth)
// This is called by the relay server, not directly by clients

/**
 * POST /authorize
 * Validates API key and returns device info
 * Called by relay before processing any AI request
 */
router.post(RELAY_BILLING_ROUTE_SEGMENTS.AUTHORIZE, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const result = await authorizeRelayApiKey((body as any)?.apiKey);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    console.log(
      `[auth/authorize] Authorized device ${result.deviceId}, balance: ${result.creditBalance}`
    );

    return c.json({
      authorized: true,
      deviceId: result.deviceId,
      creditBalance: result.creditBalance,
    });
  } catch (error: any) {
    console.error("[auth/authorize] Error:", error);
    return c.json({ error: error.message || "Authorization failed" }, 500);
  }
});

/**
 * POST /deduct
 * Generic credit deduction endpoint for all services
 * Accepts service type and appropriate metrics
 */
router.post(RELAY_BILLING_ROUTE_SEGMENTS.DEDUCT, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const result = await deductRelayCredits(body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    console.log(`[auth/deduct] ${result.logMessage}`);
    return c.json({ success: true });
  } catch (error: any) {
    console.error("[auth/deduct] Error:", error);
    return c.json({ error: error.message || "Deduction failed" }, 500);
  }
});

/**
 * POST /relay/translation-jobs/upsert
 * Durable relay translation job state writer (server-to-server only).
 */
router.post("/relay/translation-jobs/upsert", async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!relaySecret || relaySecret !== c.env.RELAY_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const jobId = String(body?.jobId || "").trim();
    const status = String(body?.status || "").trim() as
      | "queued"
      | "processing"
      | "completed"
      | "failed";
    const allowed = new Set(["queued", "processing", "completed", "failed"]);

    if (!jobId) {
      return c.json({ error: "jobId required" }, 400);
    }
    if (!allowed.has(status)) {
      return c.json({ error: `Invalid status: ${status}` }, 400);
    }

    await upsertRelayTranslationJob({
      relayJobId: jobId,
      status,
      result: body?.result,
      error:
        typeof body?.error === "string" && body.error.trim()
          ? body.error.trim()
          : null,
    });

    // Periodic best-effort cleanup.
    c.executionCtx.waitUntil(cleanupOldRelayTranslationJobs({ maxAgeHours: 24 }));

    return c.json({ success: true });
  } catch (error: any) {
    console.error("[auth/relay/translation-jobs/upsert] Error:", error);
    return c.json({ error: error?.message || "Upsert failed" }, 500);
  }
});

/**
 * GET /relay/translation-jobs/:jobId
 * Durable relay translation job state reader (server-to-server only).
 */
router.get("/relay/translation-jobs/:jobId", async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!relaySecret || relaySecret !== c.env.RELAY_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const jobId = String(c.req.param("jobId") || "").trim();
    if (!jobId) {
      return c.json({ error: "jobId required" }, 400);
    }

    const row = await getRelayTranslationJob({ relayJobId: jobId });
    if (!row) {
      return c.json({ error: "Job not found" }, 404);
    }

    let parsedResult: unknown = null;
    if (row.result) {
      try {
        parsedResult = JSON.parse(row.result);
      } catch {
        parsedResult = null;
      }
    }

    return c.json({
      jobId: row.relay_job_id,
      status: row.status,
      result: parsedResult,
      error: row.error ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (error: any) {
    console.error("[auth/relay/translation-jobs/:jobId] Error:", error);
    return c.json({ error: error?.message || "Read failed" }, 500);
  }
});

export default router;
