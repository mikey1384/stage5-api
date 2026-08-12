import { Hono } from "hono";
import { z } from "zod";
import { getUserByApiKey, isInternalDevice } from "../lib/db";
import {
  enqueueAnalyticsEventSafely,
  flushAnalyticsOutbox,
} from "../lib/product-analytics";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

const productEventSchema = z.object({
  eventId: z.string().uuid(),
  event: z.enum([
    "app_open",
    "app_meaningful_use",
    "translation_started",
    "translation_completed",
    "translation_credit_blocked",
    "translation_cancelled",
    "translation_failed",
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
});

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
