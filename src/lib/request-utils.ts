import type { Context } from "hono";
import crypto from "node:crypto";

export function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on", "high", "quality"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "low", "standard"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function getRequestIdempotencyKey(
  c: Context<any>
): string | undefined {
  const primary = c.req.header("Idempotency-Key");
  const fallback = c.req.header("X-Idempotency-Key");
  const value = (primary || fallback || "").trim();
  return value || undefined;
}

export function getRequestId(c: Context<any>): string {
  const incoming = (
    c.req.header("X-Request-Id") ||
    getRequestIdempotencyKey(c) ||
    ""
  ).trim();
  return incoming || crypto.randomUUID();
}

function normalizeIdempotencyPayload(value: unknown): unknown {
  if (value == null) return null;

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeIdempotencyPayload(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const normalizedEntries = Object.entries(source)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, normalizeIdempotencyPayload(entryValue)]);
    return Object.fromEntries(normalizedEntries);
  }

  return String(value);
}

function hashText(input: string, size = 24): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, size);
}

export function buildScopedIdempotencyKey({
  scope,
  requestIdempotencyKey,
  payload,
}: {
  scope: string;
  requestIdempotencyKey?: string;
  payload: unknown;
}): string | undefined {
  const requestKey = (requestIdempotencyKey || "").trim();
  if (!requestKey) return undefined;

  const normalizedScope = (scope || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const safeScope = normalizedScope || "request";
  const normalizedPayloadJson = JSON.stringify(
    normalizeIdempotencyPayload(payload)
  );

  const requestHash = hashText(requestKey);
  const payloadHash = hashText(normalizedPayloadJson);

  return `${safeScope}:req:${requestHash}:payload:${payloadHash}`;
}
