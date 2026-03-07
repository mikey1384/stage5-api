import crypto from "node:crypto";

export type ReplayArtifactRef = {
  version: 1;
  storage: "r2";
  key: string;
  contentType: "application/json";
  sizeBytes: number;
};

function hashText(value: string, size = 32): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, size);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function isReplayArtifactRef(value: unknown): value is ReplayArtifactRef {
  const object = asObject(value);
  return (
    object?.version === 1 &&
    object?.storage === "r2" &&
    object?.contentType === "application/json" &&
    typeof object?.key === "string" &&
    object.key.trim().length > 0 &&
    typeof object?.sizeBytes === "number" &&
    Number.isFinite(object.sizeBytes) &&
    object.sizeBytes >= 0
  );
}

export function buildReplayArtifactKey({
  service,
  deviceId,
  requestKey,
}: {
  service: string;
  deviceId: string;
  requestKey: string;
}): string {
  const serviceSegment = (service || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
  const requestHash = hashText(`${service}\n${deviceId}\n${requestKey}`, 40);
  // Keep the durable replay object key deterministic so retries and cleanups
  // target the same artifact without storing large payloads in D1 metadata.
  return `direct-replay/v1/${serviceSegment}/${requestHash}.json`;
}

export async function storeReplayArtifact({
  bucket,
  service,
  deviceId,
  requestKey,
  payload,
}: {
  bucket: R2Bucket;
  service: string;
  deviceId: string;
  requestKey: string;
  payload: unknown;
}): Promise<ReplayArtifactRef> {
  const body = JSON.stringify(payload);
  const sizeBytes = new TextEncoder().encode(body).byteLength;
  const key = buildReplayArtifactKey({
    service,
    deviceId,
    requestKey,
  });

  await bucket.put(key, body, {
    httpMetadata: {
      contentType: "application/json",
    },
    customMetadata: {
      replayVersion: "1",
      service,
    },
  });

  return {
    version: 1,
    storage: "r2",
    key,
    contentType: "application/json",
    sizeBytes,
  };
}

export async function loadReplayArtifact({
  bucket,
  artifact,
}: {
  bucket: R2Bucket;
  artifact: ReplayArtifactRef;
}): Promise<unknown> {
  const object = await bucket.get(artifact.key);
  if (!object) {
    throw new Error("Replay artifact not found");
  }

  return await object.json();
}

export async function deleteReplayArtifact({
  bucket,
  artifact,
}: {
  bucket: R2Bucket;
  artifact: ReplayArtifactRef;
}): Promise<void> {
  await bucket.delete(artifact.key);
}
