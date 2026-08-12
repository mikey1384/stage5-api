import { Hono } from "hono";
import { z } from "zod";
import { getUserByApiKey, isInternalDevice } from "../lib/db";
import {
  enqueueAnalyticsEventSafely,
  flushAnalyticsOutbox,
} from "../lib/product-analytics";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

const productEventSchema = z
  .object({
    eventId: z.string().uuid(),
    event: z.enum([
      "app_open",
      "app_meaningful_use",
      "app_critical_failure",
      "translation_started",
      "translation_completed",
      "translation_credit_blocked",
      "translation_cancelled",
      "translation_failed",
      "url_download_started",
      "url_download_completed",
      "url_download_cookie_required",
      "url_download_cancelled",
      "url_download_failed",
      "url_cookie_connect_started",
      "url_cookie_connect_completed",
      "url_cookie_connect_cancelled",
      "url_cookie_connect_failed",
    ]),
    appVersion: z.string().trim().min(1).max(32),
    platform: z.enum(["darwin", "win32", "linux"]),
    architecture: z.enum(["arm64", "x64", "ia32"]),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/),
    feature: z.enum(["video_open", "video_download"]).optional(),
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
      input.connectionContext,
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

    const result = await enqueueAnalyticsEventSafely(c.env, {
      eventId: `translator:${input.event}:${input.eventId}`,
      eventName: input.event,
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
