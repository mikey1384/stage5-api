import { getDatabase } from "./db/core";
import type { Stage5ApiBindings } from "../types/env";

const GA4_COLLECT_ENDPOINT = "https://www.google-analytics.com/mp/collect";
const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 25;

type AnalyticsParam = string | number | boolean | AnalyticsItem[];

export type AnalyticsItem = {
  item_id: string;
  item_name: string;
  price?: number;
  quantity?: number;
  item_category?: string;
};

export type AnalyticsEventParams = Record<string, AnalyticsParam>;

type AnalyticsOutboxRow = {
  event_id: string;
  event_name: string;
  client_id: string;
  params_json: string;
  occurred_at_micros: number;
  attempts: number;
};

export type AnalyticsFlushReport = {
  configured: boolean;
  selected: number;
  sent: number;
  failed: number;
};

function hasAnalyticsConfiguration(env: Stage5ApiBindings): boolean {
  return Boolean(
    env.GA4_TRANSLATOR_MEASUREMENT_ID?.trim() &&
    env.GA4_API_SECRET?.trim() &&
    env.ANALYTICS_PSEUDONYM_SECRET?.trim(),
  );
}

function normalizeEventName(value: string): string {
  const normalized = String(value || "").trim();
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(normalized)) {
    throw new Error(`Invalid analytics event name: ${normalized || "empty"}`);
  }
  return normalized;
}

function normalizeEventId(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 180) {
    throw new Error("Analytics event ID must contain 1-180 characters");
  }
  return normalized;
}

function normalizeString(value: string): string {
  return value.trim().slice(0, 100);
}

function sanitizeItems(items: AnalyticsItem[]): AnalyticsItem[] {
  return items.slice(0, 10).map((item) => {
    const sanitized: AnalyticsItem = {
      item_id: normalizeString(item.item_id),
      item_name: normalizeString(item.item_name),
    };
    if (typeof item.price === "number" && Number.isFinite(item.price)) {
      sanitized.price = item.price;
    }
    if (typeof item.quantity === "number" && Number.isFinite(item.quantity)) {
      sanitized.quantity = item.quantity;
    }
    if (typeof item.item_category === "string" && item.item_category.trim()) {
      sanitized.item_category = normalizeString(item.item_category);
    }
    return sanitized;
  });
}

function sanitizeParams(params: AnalyticsEventParams): AnalyticsEventParams {
  const sanitized: AnalyticsEventParams = {};
  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = rawKey.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;

    if (typeof rawValue === "string") {
      const value = normalizeString(rawValue);
      if (value) sanitized[key] = value;
      continue;
    }
    if (typeof rawValue === "number") {
      if (Number.isFinite(rawValue)) sanitized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "boolean") {
      sanitized[key] = rawValue;
      continue;
    }
    if (Array.isArray(rawValue) && key === "items") {
      sanitized[key] = sanitizeItems(rawValue);
    }
  }
  return sanitized;
}

function bytesToDecimal(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value.toString(10);
}

export async function deriveAnonymousClientId(
  env: Stage5ApiBindings,
  subjectKey: string,
): Promise<string | null> {
  const secret = env.ANALYTICS_PSEUDONYM_SECRET?.trim();
  const normalizedSubject = String(subjectKey || "").trim();
  if (!secret || !normalizedSubject) return null;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(normalizedSubject)),
  );
  return `${bytesToDecimal(signature.slice(0, 8))}.${bytesToDecimal(
    signature.slice(8, 16),
  )}`;
}

export async function enqueueAnalyticsEvent(
  env: Stage5ApiBindings,
  {
    eventId,
    eventName,
    subjectKey,
    params,
    occurredAt = new Date(),
    availableAt = occurredAt,
  }: {
    eventId: string;
    eventName: string;
    subjectKey: string;
    params: AnalyticsEventParams;
    occurredAt?: Date;
    availableAt?: Date;
  },
): Promise<"queued" | "duplicate" | "not_configured"> {
  if (!hasAnalyticsConfiguration(env)) return "not_configured";

  const clientId = await deriveAnonymousClientId(env, subjectKey);
  if (!clientId) return "not_configured";

  const db = getDatabase();
  const result = await db
    .prepare(
      `INSERT INTO analytics_outbox (
         event_id,
         event_name,
         client_id,
         params_json,
         occurred_at_micros,
         available_at,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .bind(
      normalizeEventId(eventId),
      normalizeEventName(eventName),
      clientId,
      JSON.stringify(sanitizeParams(params)),
      occurredAt.getTime() * 1000,
      availableAt.toISOString(),
    )
    .run();

  return Number(result?.meta?.changes ?? 0) > 0 ? "queued" : "duplicate";
}

export async function enqueueAnalyticsEventSafely(
  env: Stage5ApiBindings,
  input: Parameters<typeof enqueueAnalyticsEvent>[1],
): Promise<"queued" | "duplicate" | "not_configured" | "failed"> {
  try {
    return await enqueueAnalyticsEvent(env, input);
  } catch (error) {
    console.warn(
      `[analytics] Failed to enqueue ${input.eventName} (${input.eventId}):`,
      error,
    );
    return "failed";
  }
}

function retryAt(attempts: number): string {
  const seconds = Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function claimForDelivery(eventId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const result = await getDatabase()
    .prepare(
      `UPDATE analytics_outbox
       SET available_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE event_id = ?
         AND sent_at IS NULL
         AND available_at <= ?`,
    )
    .bind(leaseUntil, eventId, now)
    .run();
  return Number(result?.meta?.changes ?? 0) > 0;
}

async function markSent(eventId: string): Promise<void> {
  await getDatabase()
    .prepare(
      `UPDATE analytics_outbox
       SET sent_at = CURRENT_TIMESTAMP,
           attempts = attempts + 1,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE event_id = ? AND sent_at IS NULL`,
    )
    .bind(eventId)
    .run();
}

async function markFailed(
  eventId: string,
  attempts: number,
  error: string,
): Promise<void> {
  await getDatabase()
    .prepare(
      `UPDATE analytics_outbox
       SET attempts = attempts + 1,
           available_at = ?,
           last_error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE event_id = ? AND sent_at IS NULL`,
    )
    .bind(retryAt(attempts + 1), error.slice(0, 500), eventId)
    .run();
}

export async function flushAnalyticsOutbox(
  env: Stage5ApiBindings,
  { limit = DEFAULT_BATCH_LIMIT }: { limit?: number } = {},
): Promise<AnalyticsFlushReport> {
  if (!hasAnalyticsConfiguration(env)) {
    return { configured: false, selected: 0, sent: 0, failed: 0 };
  }

  const boundedLimit = Math.max(
    1,
    Math.min(MAX_BATCH_LIMIT, Math.floor(limit)),
  );
  const rows = await getDatabase()
    .prepare(
      `SELECT event_id, event_name, client_id, params_json,
              occurred_at_micros, attempts
       FROM analytics_outbox
       WHERE sent_at IS NULL AND available_at <= ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(new Date().toISOString(), boundedLimit)
    .all();
  const events = (rows?.results ?? []) as AnalyticsOutboxRow[];

  let sent = 0;
  let failed = 0;
  const endpoint = new URL(GA4_COLLECT_ENDPOINT);
  endpoint.searchParams.set(
    "measurement_id",
    env.GA4_TRANSLATOR_MEASUREMENT_ID!.trim(),
  );
  endpoint.searchParams.set("api_secret", env.GA4_API_SECRET!.trim());

  for (const event of events) {
    if (!(await claimForDelivery(event.event_id))) continue;
    try {
      const response = await fetch(endpoint.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: event.client_id,
          timestamp_micros: Number(event.occurred_at_micros),
          non_personalized_ads: true,
          events: [
            {
              name: event.event_name,
              params: JSON.parse(event.params_json),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`GA4 Measurement Protocol HTTP ${response.status}`);
      }
      await markSent(event.event_id);
      sent += 1;
    } catch (error) {
      failed += 1;
      await markFailed(
        event.event_id,
        Number(event.attempts ?? 0),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    configured: true,
    selected: events.length,
    sent,
    failed,
  };
}
