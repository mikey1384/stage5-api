import { Hono } from "hono";
import {
  upsertRelayTranslationJob,
  getRelayTranslationJob,
  cleanupOldRelayTranslationJobs,
  getDeviceApiTokenRecord,
  beginOrReplayLegacyBootstrapIssue,
  beginOrReplayRecoveryIssue,
  getUserByOpaqueApiToken,
  isLikelyLegacyDeviceId,
} from "../lib/db";
import {
  deleteReplayArtifact,
  isReplayArtifactRef,
  loadReplayArtifact,
  storeReplayArtifact,
} from "../lib/replay-artifacts";
import {
  authorizeRelayApiKey,
  confirmRelayReservation,
  finalizeRelayCredits,
  hasValidRelaySecret,
  persistRelayReservationMeta,
  releaseRelayCredits,
  reserveRelayCredits,
  RELAY_BILLING_ROUTE_SEGMENTS,
} from "../lib/relay-billing";
import { uuidSchema } from "../lib/schemas";
import {
  evaluateTranslatorVersion,
  TRANSLATOR_VERSION_HEADER,
} from "../lib/translator-version-gate";
import {
  getOrCreateRuntimeSecret,
  getRuntimeStateValue,
} from "../lib/runtime-state";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();
let didWarnDeviceTokenSecretMismatch = false;

// All routes in this file use X-Relay-Secret (not bearer auth)
// This is called by the relay server, not directly by clients

async function resolveDeviceTokenSecret(
  env: Stage5ApiBindings
): Promise<string> {
  const explicit = String(env.DEVICE_TOKEN_SECRET || "").trim();
  const existing = await getRuntimeStateValue({
    stateKey: "device-token-secret-v1",
  });
  if (existing) {
    if (
      explicit &&
      explicit !== existing &&
      !didWarnDeviceTokenSecretMismatch
    ) {
      didWarnDeviceTokenSecretMismatch = true;
      console.warn(
        "[auth/device-token] Ignoring DEVICE_TOKEN_SECRET env change because device-token-secret-v1 is already persisted in runtime_state. Pending replays and existing device tokens continue using the persisted canonical secret."
      );
    }
    return existing;
  }

  // Seed the canonical device-token secret once and persist it. Later env
  // changes must not change replayed credentials for already-issued pending
  // bootstrap/recovery responses.
  return getOrCreateRuntimeSecret({
    stateKey: "device-token-secret-v1",
    preferredInitialValue:
      explicit ||
      String(env.STRIPE_WEBHOOK_SECRET || "").trim() ||
      String(env.RELAY_SECRET || "").trim() ||
      null,
  });
}

function buildRelayMutationResponse(result: {
  status: string;
  reservationStatus?: string;
  reservationMeta?: unknown;
  reservationUpdatedAt?: string;
}): Record<string, unknown> {
  return {
    success: true,
    status: result.status,
    ...(result.reservationStatus
      ? { reservationStatus: result.reservationStatus }
      : {}),
    ...(typeof result.reservationMeta !== "undefined"
      ? { reservationMeta: result.reservationMeta }
      : {}),
    ...(result.reservationUpdatedAt
      ? { reservationUpdatedAt: result.reservationUpdatedAt }
      : {}),
  };
}

router.post("/device-token", async (c) => {
  try {
    const body = await c.req.json<{ deviceId?: string }>();
    const deviceId = String(body?.deviceId || "").trim();
    uuidSchema.parse(deviceId);
    const authHeader = String(c.req.header("Authorization") || "").trim();
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!bearerToken) {
      return c.json(
        {
          error: "unauthorized",
          message: "Bearer auth required",
        },
        401
      );
    }

    if (isLikelyLegacyDeviceId(bearerToken)) {
      if (bearerToken !== deviceId) {
        return c.json(
          {
            error: "unauthorized",
            message: "Legacy device bearer does not match requested device",
          },
          401
        );
      }

      const existingToken = await getDeviceApiTokenRecord({ deviceId });
      if (existingToken) {
        if (!existingToken.legacy_bootstrap_allowed) {
          return c.json(
            {
              error: "device-token-already-provisioned",
              message:
                "Legacy device bearer auth is disabled after the opaque API token has been confirmed. Use the stored opaque API token or recovery token to rotate credentials.",
            },
            409
          );
        }
      }

      const deviceTokenSecret = await resolveDeviceTokenSecret(c.env);
      const issued = await beginOrReplayLegacyBootstrapIssue({
        deviceId,
        secret: deviceTokenSecret,
      });
      if (!issued) {
        return c.json(
          {
            error: "device-token-already-provisioned",
            message:
              "Legacy device bearer auth is disabled after the opaque API token has been confirmed. Use the stored opaque API token or recovery token to rotate credentials.",
          },
          409
        );
      }

      return c.json({
        deviceId,
        apiToken: issued.apiToken,
        recoveryToken: issued.recoveryToken,
        mode: issued.replayed
          ? "provisioning-replayed"
          : existingToken
            ? "reprovisioned"
            : "provisioned",
      });
    }

    const deviceTokenSecret = await resolveDeviceTokenSecret(c.env);
    const recovered = await beginOrReplayRecoveryIssue({
      deviceId,
      recoveryToken: bearerToken,
      secret: deviceTokenSecret,
    });
    if (recovered) {
      return c.json({
        deviceId,
        apiToken: recovered.apiToken,
        recoveryToken: recovered.recoveryToken,
        mode: recovered.replayed ? "recovery-replayed" : "recovered",
      });
    }

    const authUser = await getUserByOpaqueApiToken({ apiToken: bearerToken });
    if (!authUser || authUser.device_id !== deviceId) {
      return c.json(
        {
          error: "unauthorized",
          message: "Opaque API token does not match requested device",
        },
        401
      );
    }

    return c.json({
      deviceId,
      apiToken: bearerToken,
      mode: "verified",
    });
  } catch (error: any) {
    return c.json(
      {
        error: "invalid-request",
        message: error?.message || "Failed to provision device token",
      },
      400
    );
  }
});

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
    const versionGate = evaluateTranslatorVersion({
      minVersionRaw: c.env.MIN_TRANSLATOR_VERSION,
      enforcementRaw: c.env.MIN_TRANSLATOR_VERSION_ENFORCEMENT,
      downloadUrlRaw: c.env.TRANSLATOR_DOWNLOAD_URL,
      clientVersionRaw:
        typeof (body as any)?.appVersion === "string"
          ? (body as any).appVersion
          : c.req.header(TRANSLATOR_VERSION_HEADER),
    });
    if (versionGate.payload && versionGate.mode === "enforce") {
      return c.json(versionGate.payload, 426);
    }

    const result = await authorizeRelayApiKey(body);
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

router.post(RELAY_BILLING_ROUTE_SEGMENTS.CONFIRM, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const result = await confirmRelayReservation(body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    console.log(`[auth/confirm] ${result.logMessage}`);
    return c.json({ success: true, status: result.status });
  } catch (error: any) {
    console.error("[auth/confirm] Error:", error);
    return c.json({ error: error.message || "Reservation confirm failed" }, 500);
  }
});

/**
 * POST /reserve
 * Reserve credits before vendor work starts.
 */
router.post(RELAY_BILLING_ROUTE_SEGMENTS.RESERVE, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const result = await reserveRelayCredits(body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    console.log(`[auth/reserve] ${result.logMessage}`);
    return c.json(buildRelayMutationResponse(result));
  } catch (error: any) {
    console.error("[auth/reserve] Error:", error);
    return c.json({ error: error.message || "Reservation failed" }, 500);
  }
});

router.post(RELAY_BILLING_ROUTE_SEGMENTS.FINALIZE, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const result = await finalizeRelayCredits(body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    console.log(`[auth/finalize] ${result.logMessage}`);
    return c.json(buildRelayMutationResponse(result));
  } catch (error: any) {
    console.error("[auth/finalize] Error:", error);
    return c.json({ error: error.message || "Finalize failed" }, 500);
  }
});

router.post(RELAY_BILLING_ROUTE_SEGMENTS.PERSIST, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const result = await persistRelayReservationMeta(body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    console.log(`[auth/persist] ${result.logMessage}`);
    return c.json(buildRelayMutationResponse(result));
  } catch (error: any) {
    console.error("[auth/persist] Error:", error);
    return c.json({ error: error.message || "Persist failed" }, 500);
  }
});

router.post(RELAY_BILLING_ROUTE_SEGMENTS.RELEASE, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const result = await releaseRelayCredits(body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    console.log(`[auth/release] ${result.logMessage}`);
    return c.json(buildRelayMutationResponse(result));
  } catch (error: any) {
    console.error("[auth/release] Error:", error);
    return c.json({ error: error.message || "Release failed" }, 500);
  }
});

router.post(RELAY_BILLING_ROUTE_SEGMENTS.REPLAY_STORE, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json<Record<string, unknown>>();
    const deviceId = String(body?.deviceId || "").trim();
    const service = String(body?.service || "").trim().toLowerCase();
    const requestKey = String(body?.requestKey || "").trim();
    if (!deviceId || !service || !requestKey) {
      return c.json(
        { error: "deviceId, service, and requestKey required" },
        400
      );
    }

    const artifact = await storeReplayArtifact({
      bucket: c.env.TRANSCRIPTION_BUCKET,
      deviceId,
      service,
      requestKey,
      payload: body?.payload,
    });

    return c.json({ success: true, artifact });
  } catch (error: any) {
    console.error("[auth/replay-store] Error:", error);
    return c.json(
      { error: error?.message || "Replay artifact store failed" },
      500
    );
  }
});

router.post(RELAY_BILLING_ROUTE_SEGMENTS.REPLAY_LOAD, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json<Record<string, unknown>>();
    const artifact = body?.artifact;
    if (!isReplayArtifactRef(artifact)) {
      return c.json({ error: "Valid artifact required" }, 400);
    }

    const payload = await loadReplayArtifact({
      bucket: c.env.TRANSCRIPTION_BUCKET,
      artifact,
    });
    return c.json({ success: true, payload });
  } catch (error: any) {
    const message = error?.message || "Replay artifact load failed";
    const status = String(message).includes("not found") ? 404 : 500;
    console.error("[auth/replay-load] Error:", error);
    return c.json({ error: message }, status as 404 | 500);
  }
});

router.post(RELAY_BILLING_ROUTE_SEGMENTS.REPLAY_DELETE, async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json<Record<string, unknown>>();
    const artifact = body?.artifact;
    if (!isReplayArtifactRef(artifact)) {
      return c.json({ error: "Valid artifact required" }, 400);
    }

    await deleteReplayArtifact({
      bucket: c.env.TRANSCRIPTION_BUCKET,
      artifact,
    });
    return c.json({ success: true });
  } catch (error: any) {
    console.error("[auth/replay-delete] Error:", error);
    return c.json(
      { error: error?.message || "Replay artifact delete failed" },
      500
    );
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
