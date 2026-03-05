import crypto from "node:crypto";

export function extractTranslationIdempotencyKey(
  payload: Record<string, unknown> | null | undefined
): string | undefined {
  const raw = payload?.idempotencyKey;
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  return key || undefined;
}

export function resolveTranslationBillingIdempotencyKey({
  jobId,
  payload,
}: {
  jobId: string;
  payload: Record<string, unknown> | null | undefined;
}): string {
  const scopedBaseKey = `translation-job:${jobId}`;
  const requestIdempotencyKey = extractTranslationIdempotencyKey(payload);
  if (!requestIdempotencyKey) {
    return scopedBaseKey;
  }

  const fingerprint = crypto
    .createHash("sha256")
    .update(requestIdempotencyKey)
    .digest("hex")
    .slice(0, 24);
  return `${scopedBaseKey}:req:${fingerprint}`;
}
