import { readAnalyticsPreference, saveAnalyticsPreference } from "../lib/analytics-preferences";
import { Hono } from "hono";
import { z } from "zod";
import { getUserByApiKey, isInternalDevice } from "../lib/db";
import {
  enqueueAnalyticsEventSafely,
  flushAnalyticsOutbox,
} from "../lib/product-analytics";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

export const PRODUCT_EVENT_NAMES = [
  "app_open",
  "app_meaningful_use",
  "app_critical_failure",
  "translation_started",
  "translation_completed",
  "translation_credit_blocked",
  "translation_cancelled",
  "translation_failed",
  "transcription_started",
  "transcription_completed",
  "transcription_credit_blocked",
  "transcription_cancelled",
  "transcription_failed",
  "dubbing_started",
  "dubbing_completed",
  "dubbing_credit_blocked",
  "dubbing_cancelled",
  "dubbing_failed",
  "summary_started",
  "summary_completed",
  "summary_credit_blocked",
  "summary_cancelled",
  "summary_failed",
  "merge_started",
  "merge_completed",
  "merge_cancelled",
  "merge_failed",
  "credit_checkout_button_shown",
  "credit_checkout_button_clicked",
  "credit_checkout_session_created",
  "credit_checkout_opened",
  "credit_checkout_completed",
  "credit_checkout_failed",
  "credit_checkout_cancelled",
  "byo_unlock_button_shown",
  "byo_unlock_button_clicked",
  "byo_unlock_session_created",
  "byo_unlock_opened",
  "byo_unlock_completed",
  "byo_unlock_failed",
  "byo_unlock_cancelled",
  "free_preview_ready",
  "free_preview_offer_clicked",
  "free_preview_resumed",
  "free_preview_dismissed",
  "free_preview_completed",
  "free_preview_failed",
  "url_download_started",
  "url_download_completed",
  "url_download_caption_only",
  "url_download_cookie_required",
  "url_download_cancelled",
  "url_download_failed",
  "url_cookie_connect_started",
  "url_cookie_connect_completed",
  "url_cookie_connect_cancelled",
  "url_cookie_connect_failed",
] as const;

const productEventSchema = z
  .object({
    eventId: z.string().uuid(),
    occurredAt: z.string().datetime().optional(),
    consentRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    event: z.enum(PRODUCT_EVENT_NAMES),
    appVersion: z.string().trim().min(1).max(32),
    platform: z.enum(["darwin", "win32", "linux"]),
    architecture: z.enum(["arm64", "x64", "ia32"]),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/),
    feature: z.enum(["video_open", "video_download", "translation"]).optional(),
    workflow: z.enum(["full_srt"]).optional(),
    failureClass: z
      .enum([
        "startup_incomplete",
        "main_module_load_failed",
        "startup_initialization_failed",
        "main_process_exception",
        "main_process_rejection",
        "renderer_process_gone",
        "child_process_gone",
        "renderer_window_hung",
      ])
      .optional(),
    startupPhase: z
      .enum([
        "module_load",
        "services_initialization",
        "app_ready",
        "startup_cleanup",
        "window_creation",
        "renderer_ready",
        "runtime",
      ])
      .optional(),
    failedAppVersion: z.string().trim().min(1).max(32).optional(),
    failedPlatform: z.enum(["darwin", "win32", "linux"]).optional(),
    failedArchitecture: z.enum(["arm64", "x64", "ia32"]).optional(),
    processReason: z
      .enum([
        "clean-exit",
        "abnormal-exit",
        "killed",
        "crashed",
        "oom",
        "launch-failed",
        "integrity-failure",
        "unknown",
      ])
      .optional(),
    sourceType: z.enum(["youtube", "other"]).optional(),
    cookieCause: z
      .enum(["rate_limited", "login_required", "human_verification", "other"])
      .optional(),
    downloadFailure: z
      .enum([
        "validation",
        "runtime_setup",
        "network",
        "site_rejected",
        "storage",
        "postprocessing",
        "unknown",
      ])
      .optional(),
    connectionContext: z.enum(["download_recovery", "settings"]).optional(),
    mediaFailure: z.enum(["http_403"]).optional(),
    packId: z.enum(["MICRO", "STARTER", "STANDARD", "PRO"]).optional(),
    placement: z
      .enum([
        "zero-credit-banner",
        "credit-ran-out-dialog",
        "settings-credit-card",
        "settings-byo",
        "agent",
        "free-preview-offer",
      ])
      .optional(),
    failureReason: z
      .enum([
        "network_error",
        "api_error",
        "stripe_error",
        "settlement_timeout",
        "already_pending",
        "unknown",
      ])
      .optional(),
  })
  .strict();

async function authenticatedDeviceId(c: any): Promise<string | null> {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  const user = await getUserByApiKey({ apiKey: token });
  return user?.device_id ?? null;
}

function flushInBackground(c: any): void {
  const flush = flushAnalyticsOutbox(c.env).catch((error) => {
    console.warn("[analytics] Background flush failed:", error);
  });
  try {
    c.executionCtx.waitUntil(flush);
  } catch {
    void flush;
  }
}

const preferenceSchema = z.object({
  enabled: z.boolean(), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

router.get("/preferences", async (c) => {
  const deviceId = await authenticatedDeviceId(c);
  if (!deviceId) return c.json({ error: "Missing authorization" }, 401);
  const result = await readAnalyticsPreference(c.env, `translator-device:${deviceId}`);
  return result ? c.json(result) : c.json({ error: "Preferences temporarily unavailable" }, 503);
});

router.post("/preferences", async (c) => {
  const deviceId = await authenticatedDeviceId(c);
  if (!deviceId) return c.json({ error: "Missing authorization" }, 401);
  try {
    const input = preferenceSchema.parse(await c.req.json());
    const result = await saveAnalyticsPreference(c.env, `translator-device:${deviceId}`, input);
    return result ? c.json(result) : c.json({ error: "Preferences temporarily unavailable" }, 503);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: "Invalid preference" }, 400);
    return c.json({ error: "Preferences temporarily unavailable" }, 503);
  }
});

router.post("/events", async (c) => {
  const deviceId = await authenticatedDeviceId(c);
  if (!deviceId) {
    return c.json(
      {
        error: "Missing authorization",
        message: "A valid Stage5 device token is required",
      },
      401,
    );
  }

  try {
    const input = productEventSchema.parse(await c.req.json());
    if (input.event === "app_meaningful_use" && !input.feature) {
      return c.json(
        {
          error: "Invalid request data",
          message: "Meaningful-use events require an allowlisted feature",
        },
        400,
      );
    }
    if (input.event === "app_open" && (input.feature || input.workflow)) {
      return c.json(
        {
          error: "Invalid request data",
          message: "App-open events cannot contain a feature or workflow",
        },
        400,
      );
    }
    if (input.event === "app_meaningful_use" && input.workflow) {
      return c.json(
        {
          error: "Invalid request data",
          message: "Meaningful-use events cannot contain a workflow",
        },
        400,
      );
    }
    if (
      input.event.startsWith("translation_") &&
      (!input.workflow || input.feature)
    ) {
      return c.json(
        {
          error: "Invalid request data",
          message:
            "Translation events require an allowlisted workflow and cannot contain a feature",
        },
        400,
      );
    }
    const hasFailureFields = Boolean(
      input.failureClass ||
      input.startupPhase ||
      input.failedAppVersion ||
      input.failedPlatform ||
      input.failedArchitecture ||
      input.processReason,
    );
    const isPurchaseDiagnostic =
      input.event.startsWith("credit_checkout_") ||
      input.event.startsWith("byo_unlock_");
    const hasPurchaseFields = Boolean(
      input.packId || input.placement || input.failureReason,
    );
    const isAdditionalWorkflow = [
      "transcription_", "dubbing_", "summary_", "merge_",
    ].some((prefix) => input.event.startsWith(prefix));
    if (
      (!isPurchaseDiagnostic && hasPurchaseFields) ||
      ((isPurchaseDiagnostic || isAdditionalWorkflow) &&
        (input.feature || input.workflow)) ||
      (input.event.startsWith("byo_unlock_") && input.packId) ||
      (input.failureReason && !input.event.endsWith("_failed"))
    ) {
      return c.json(
        {
          error: "Invalid request data",
          message: "Event context does not match the declared desktop diagnostic",
        },
        400,
      );
    }
    const isProcessFailure =
      input.failureClass === "renderer_process_gone" ||
      input.failureClass === "child_process_gone";
    if (
      input.event === "app_critical_failure" &&
      (!input.failureClass ||
        !input.startupPhase ||
        !input.failedAppVersion ||
        !input.failedPlatform ||
        !input.failedArchitecture ||
        input.feature ||
        input.workflow ||
        isProcessFailure !== Boolean(input.processReason))
    ) {
      return c.json(
        {
          error: "Invalid request data",
          message:
            "Critical-failure events require minimized failure dimensions and cannot contain feature or workflow data",
        },
        400,
      );
    }
    if (input.event !== "app_critical_failure" && hasFailureFields) {
      return c.json(
        {
          error: "Invalid request data",
          message:
            "Failure dimensions are accepted only for critical-failure events",
        },
        400,
      );
    }
    const isUrlDownloadEvent = input.event.startsWith("url_download_");
    const isUrlConnectionEvent = input.event.startsWith("url_cookie_connect_");
    const isUrlEvent = isUrlDownloadEvent || isUrlConnectionEvent;
    const hasUrlFields = Boolean(
      input.sourceType ||
      input.cookieCause ||
      input.downloadFailure ||
      input.connectionContext ||
      input.mediaFailure,
    );
    const hasInvalidUrlEventShape =
      isUrlEvent &&
      (!input.sourceType ||
        input.feature ||
        input.workflow ||
        hasFailureFields ||
        (input.event === "url_download_cookie_required") !==
          Boolean(input.cookieCause) ||
        (input.event === "url_download_failed") !==
          Boolean(input.downloadFailure) ||
        (input.event === "url_download_caption_only") !==
          Boolean(input.mediaFailure) ||
        (input.event === "url_download_caption_only" &&
          input.sourceType !== "youtube") ||
        isUrlConnectionEvent !== Boolean(input.connectionContext));
    if (hasInvalidUrlEventShape) {
      return c.json(
        {
          error: "Invalid request data",
          message:
            "URL funnel events require only their allowlisted coarse dimensions",
        },
        400,
      );
    }
    if (!isUrlEvent && hasUrlFields) {
      return c.json(
        {
          error: "Invalid request data",
          message: "URL funnel dimensions are accepted only for URL events",
        },
        400,
      );
    }

    if (await isInternalDevice({ deviceId })) {
      return c.json({ ok: true, duplicate: false, excluded: true }, 202);
    }

    // Old app versions have no user choice. Acknowledge without collecting.
    if (input.consentRevision === undefined) {
      return c.json({ ok: true, duplicate: false, excluded: true }, 202);
    }
    const result = await enqueueAnalyticsEventSafely(c.env, {
      eventId: `translator:${input.event}:${input.eventId}`,
      eventName: input.event,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      consentRevision: input.consentRevision,
      subjectKey: `translator-device:${deviceId}`,
      params: {
        app_version: input.appVersion,
        operating_system: input.platform,
        architecture: input.architecture,
        app_locale: input.locale.replace(/_/g, "-"),
        ...(input.feature ? { feature: input.feature } : {}),
        ...(input.workflow ? { workflow: input.workflow } : {}),
        ...(input.failureClass ? { failure_class: input.failureClass } : {}),
        ...(input.startupPhase ? { startup_phase: input.startupPhase } : {}),
        ...(input.failedAppVersion
          ? { failed_app_version: input.failedAppVersion }
          : {}),
        ...(input.failedPlatform
          ? { failed_operating_system: input.failedPlatform }
          : {}),
        ...(input.failedArchitecture
          ? { failed_architecture: input.failedArchitecture }
          : {}),
        ...(input.processReason ? { process_reason: input.processReason } : {}),
        ...(input.sourceType ? { source_type: input.sourceType } : {}),
        ...(input.cookieCause ? { cookie_cause: input.cookieCause } : {}),
        ...(input.downloadFailure
          ? { download_failure: input.downloadFailure }
          : {}),
        ...(input.connectionContext
          ? { connection_context: input.connectionContext }
          : {}),
        ...(input.mediaFailure ? { media_failure: input.mediaFailure } : {}),
        ...(input.packId ? { pack_id: input.packId } : {}),
        ...(input.placement ? { placement: input.placement } : {}),
        ...(input.failureReason ? { failure_reason: input.failureReason } : {}),
        // Client completion reports never supply purchase values or settlement IDs.
        ...(isPurchaseDiagnostic
          ? {
              commerce_surface: "translator_desktop",
              attribution_scope: "desktop_diagnostic",
            }
          : {}),
        engagement_time_msec: 1,
      },
    });

    if (result === "failed" || result === "not_configured") {
      return c.json(
        {
          error: "Measurement temporarily unavailable",
          retryable: true,
        },
        503,
      );
    }

    if (result === "excluded") return c.json({ ok: true, duplicate: false, excluded: true }, 202);
    flushInBackground(c);
    return c.json({ ok: true, duplicate: result === "duplicate" }, 202);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.errors },
        400,
      );
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.name === "SyntaxError")
    ) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    console.error("[analytics] Product-event request failed:", error);
    return c.json({ error: "Measurement request failed" }, 500);
  }
});

export default router;
