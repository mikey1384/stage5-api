import { Context, Hono } from "hono";
import {
  creditDevice,
  resetCreditsToZero,
  countQueuedTranslationJobs,
  countTranslationJobsInFlight,
  getTranslationJobStatusCounts,
  getTranscriptionJobStatusCounts,
} from "../lib/db";
import { getObservabilitySnapshot } from "../lib/observability";
import { runReconciliation } from "../lib/reconciliation";
import { packs } from "../types/packs";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

function authorizeAdminDevice(
  c: Context<{ Bindings: Stage5ApiBindings }>,
  rawDeviceId: unknown
): Response | null {
  const configuredAdminDeviceId = String(c.env.ADMIN_DEVICE_ID || "").trim();
  if (!configuredAdminDeviceId) {
    console.error("[admin] Rejecting admin request: ADMIN_DEVICE_ID is not configured.");
    return c.json({ error: "admin-not-configured" }, 503);
  }

  const requestDeviceId =
    typeof rawDeviceId === "string" ? rawDeviceId.trim() : "";
  if (!requestDeviceId || requestDeviceId !== configuredAdminDeviceId) {
    return c.json({ error: "not-authorised" }, 403);
  }

  return null;
}

router.post("/add-credits", async (c) => {
  try {
    const body = await c.req.json<{
      deviceId: string;
      pack: keyof typeof packs;
    }>();
    const { deviceId, pack } = body;

    const notAuthorized = authorizeAdminDevice(c, deviceId);
    if (notAuthorized) return notAuthorized;

    // Validate pack exists
    if (!packs[pack]) {
      return c.json({ error: "invalid-pack" }, 400);
    }

    await creditDevice({ deviceId, packId: pack, isAdminReset: true });

    console.log(
      `Admin add credits: Added ${packs[pack].credits} credits to device ${deviceId}`
    );

    return c.json({
      success: true,
      creditsAdded: packs[pack].credits,
      pack: pack,
    });
  } catch (error) {
    console.error("Admin reset error:", error);
    return c.json(
      {
        error: "add-credits-failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

router.post("/reset-to-zero", async (c) => {
  try {
    const body = await c.req.json<{
      deviceId: string;
    }>();
    const { deviceId } = body;

    const notAuthorized = authorizeAdminDevice(c, deviceId);
    if (notAuthorized) return notAuthorized;

    await resetCreditsToZero({ deviceId });

    console.log(`Admin reset to zero: Set credits to 0 for device ${deviceId}`);

    return c.json({
      success: true,
    });
  } catch (error) {
    console.error("Admin reset to zero error:", error);
    return c.json(
      {
        error: "reset-to-zero-failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

router.post("/reconcile", async (c) => {
  try {
    const body = await c.req.json<{
      deviceId: string;
      dryRun?: boolean;
      limit?: number;
      translationStaleMinutes?: number;
      transcriptionPendingUploadStaleMinutes?: number;
      transcriptionProcessingStaleMinutes?: number;
      cleanupMaxAgeHours?: number;
    }>();

    const { deviceId } = body;
    const notAuthorized = authorizeAdminDevice(c, deviceId);
    if (notAuthorized) return notAuthorized;

    const report = await runReconciliation({
      dryRun: body?.dryRun === true,
      limit: body?.limit,
      translationStaleMinutes: body?.translationStaleMinutes,
      transcriptionPendingUploadStaleMinutes:
        body?.transcriptionPendingUploadStaleMinutes,
      transcriptionProcessingStaleMinutes:
        body?.transcriptionProcessingStaleMinutes,
      cleanupMaxAgeHours: body?.cleanupMaxAgeHours,
    });

    console.log(
      `[admin/reconcile] dryRun=${report.dryRun} translation(scanned=${report.translation.scanned}, rebilled=${report.translation.rebilled}, reset=${report.translation.staleRelayReset}) transcription(scanned=${report.transcription.scanned}, failed=${report.transcription.markedFailed})`
    );

    return c.json({ success: true, report });
  } catch (error) {
    console.error("Admin reconcile error:", error);
    return c.json(
      {
        error: "reconcile-failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

router.get("/metrics", async (c) => {
  try {
    const deviceId = (c.req.query("deviceId") || "").trim();
    const notAuthorized = authorizeAdminDevice(c, deviceId);
    if (notAuthorized) return notAuthorized;

    const observability = getObservabilitySnapshot();
    const [
      translationQueued,
      translationInFlight,
      translationStatusCounts,
      transcriptionStatusCounts,
    ] = await Promise.all([
      countQueuedTranslationJobs(),
      countTranslationJobsInFlight(),
      getTranslationJobStatusCounts(),
      getTranscriptionJobStatusCounts(),
    ]);

    return c.json({
      success: true,
      generatedAt: observability.generatedAt,
      uptimeSec: observability.uptimeSec,
      translationQueue: {
        queued: translationQueued,
        inFlight: translationInFlight,
      },
      translationStatusCounts,
      transcriptionStatusCounts,
      counters: observability.counters,
      durations: observability.durations,
    });
  } catch (error) {
    console.error("Admin metrics error:", error);
    return c.json(
      {
        error: "metrics-failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default router;
