import { Hono } from "hono";
import { z } from "zod";
import { PRODUCT_EVENT_NAMES } from "./analytics";
import type { Stage5ApiBindings } from "../types/env";

// Anonymous step counts. The request carries no device id or token and the
// handler stores nothing about the sender: only per-day totals per event,
// platform and app version.
// The Home link buttons and the download handoff card (Translator 1.33+).
// Anonymous counts only: the app does not send these as opt-in events, so
// they are deliberately not in PRODUCT_EVENT_NAMES.
export const HANDOFF_USAGE_COUNT_EVENTS = [
  "home_translate_clicked",
  "home_download_only_clicked",
  "download_handoff_shown",
  "download_handoff_clicked",
  "download_handoff_dismissed",
  "download_handoff_translation_started",
] as const;

// The one-tap answer to "What held you back?" after the free-preview offer
// is dismissed (Translator 1.34+). Anonymous counts only, like the above.
export const FREE_PREVIEW_DISMISS_REASON_EVENTS = [
  "free_preview_dismiss_price",
  "free_preview_dismiss_quality",
  "free_preview_dismiss_enough",
  "free_preview_dismiss_trying",
  "free_preview_dismiss_download_only",
] as const;

export const USAGE_COUNT_EVENTS = [
  ...PRODUCT_EVENT_NAMES,
  "app_first_open",
  ...HANDOFF_USAGE_COUNT_EVENTS,
  ...FREE_PREVIEW_DISMISS_REASON_EVENTS,
] as const;

const MAX_COUNT_PER_ENTRY = 500;
const MAX_DAY_AGE_DAYS = 14;

const usageCountsSchema = z.object({
  appVersion: z
    .string()
    .trim()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,20})?$/),
  platform: z.enum(["darwin", "win32", "linux"]),
  counts: z
    .array(
      z.object({
        event: z.enum(USAGE_COUNT_EVENTS),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        n: z.number().int().min(1).max(MAX_COUNT_PER_ENTRY),
      }),
    )
    .min(1)
    .max(100),
});

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Days outside [today - MAX_DAY_AGE_DAYS, today] are counted on today. */
export function clampUsageDay(day: string, now = new Date()): string {
  const today = utcDay(now);
  const oldest = utcDay(new Date(now.getTime() - MAX_DAY_AGE_DAYS * 86_400_000));
  return day > today || day < oldest ? today : day;
}

const router = new Hono<{ Bindings: Stage5ApiBindings }>();

router.post("/counts", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = usageCountsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_counts" }, 400);

  const { appVersion, platform, counts } = parsed.data;
  const now = new Date();
  const upsert = `INSERT INTO usage_counts (day, event, platform, app_version, count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (day, event, platform, app_version)
     DO UPDATE SET count = count + excluded.count, updated_at = CURRENT_TIMESTAMP`;
  await c.env.DB.batch(
    counts.map(({ event, day, n }) =>
      c.env.DB.prepare(upsert).bind(
        clampUsageDay(day, now),
        event,
        platform,
        appVersion,
        n,
      ),
    ),
  );
  return c.body(null, 204);
});

export default router;
