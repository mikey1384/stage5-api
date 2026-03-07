import {
  deleteReplayArtifact,
  isReplayArtifactRef,
  loadReplayArtifact,
  storeReplayArtifact,
  type ReplayArtifactRef,
} from "./replay-artifacts";

export type JsonReplayResult =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "error"; status: number; body: unknown };

export type StoredJsonReplayResult =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "success"; status: number; artifact: ReplayArtifactRef }
  | { kind: "error"; status: number; body: unknown };

export type JsonReplayEntry = {
  done: boolean;
  promise: Promise<JsonReplayResult>;
  resolve: (result: JsonReplayResult) => void;
  result?: JsonReplayResult;
  expiresAt?: number;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function createJsonReplayEntry(): JsonReplayEntry {
  let resolve!: (result: JsonReplayResult) => void;
  const promise = new Promise<JsonReplayResult>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    done: false,
    promise,
    resolve,
  };
}

export function settleJsonReplayEntry({
  cache,
  requestKey,
  entry,
  result,
  ttlMs,
  cacheSuccess = result.kind === "success",
}: {
  cache: Map<string, JsonReplayEntry>;
  requestKey: string;
  entry: JsonReplayEntry;
  result: JsonReplayResult;
  ttlMs: number;
  cacheSuccess?: boolean;
}): void {
  if (entry.done) {
    return;
  }

  entry.done = true;
  entry.result = result;
  entry.resolve(result);

  if (cacheSuccess && result.kind === "success") {
    entry.expiresAt = Date.now() + ttlMs;
    cache.set(requestKey, entry);
    return;
  }

  cache.delete(requestKey);
}

export function pruneJsonReplayCache(
  cache: Map<string, JsonReplayEntry>,
  now = Date.now()
): void {
  for (const [requestKey, entry] of cache.entries()) {
    if (
      entry.done &&
      entry.result?.kind === "success" &&
      typeof entry.expiresAt === "number" &&
      entry.expiresAt <= now
    ) {
      cache.delete(requestKey);
    }
  }
}

export function parseReplayMeta(raw: string | null | undefined): unknown {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function extractStoredJsonReplayEnvelope(
  reservationMeta: unknown
): StoredJsonReplayResult | null {
  const metaObject = asObject(reservationMeta);
  const replayObject = asObject(metaObject?.directReplayResult);
  if (!replayObject) {
    return null;
  }

  const kind = replayObject.kind;
  const status = replayObject.status;
  if (
    (kind !== "success" && kind !== "error") ||
    typeof status !== "number" ||
    !Number.isFinite(status)
  ) {
    return null;
  }

  const artifact = isReplayArtifactRef(replayObject.artifact)
    ? replayObject.artifact
    : null;
  if (kind === "success" && artifact) {
    return {
      kind,
      status,
      artifact,
    };
  }

  const body =
    Object.prototype.hasOwnProperty.call(replayObject, "body")
      ? replayObject.body
      : replayObject.data;
  if (typeof body === "undefined") {
    return null;
  }

  if (kind === "success") {
    return {
      kind,
      status,
      body,
    };
  }

  return {
    kind,
    status,
    body,
  };
}

export function extractStoredJsonReplay(
  reservationMeta: unknown
): JsonReplayResult | null {
  const storedReplay = extractStoredJsonReplayEnvelope(reservationMeta);
  if (!storedReplay) {
    return null;
  }
  if (storedReplay.kind === "success" && "artifact" in storedReplay) {
    return null;
  }
  return storedReplay;
}

export async function resolveStoredJsonReplay({
  bucket,
  storedReplay,
}: {
  bucket: R2Bucket;
  storedReplay: StoredJsonReplayResult | null;
}): Promise<JsonReplayResult | null> {
  if (!storedReplay) {
    return null;
  }

  if (storedReplay.kind === "success" && "artifact" in storedReplay) {
    return {
      kind: "success",
      status: storedReplay.status,
      body: await loadReplayArtifact({
        bucket,
        artifact: storedReplay.artifact,
      }),
    };
  }

  return storedReplay;
}

export async function storeSuccessJsonReplayArtifact({
  bucket,
  service,
  deviceId,
  requestKey,
  replay,
}: {
  bucket: R2Bucket;
  service: string;
  deviceId: string;
  requestKey: string;
  replay: Extract<JsonReplayResult, { kind: "success" }>;
}): Promise<StoredJsonReplayResult> {
  const artifact = await storeReplayArtifact({
    bucket,
    service,
    deviceId,
    requestKey,
    payload: replay.body,
  });
  return {
    kind: "success",
    status: replay.status,
    artifact,
  };
}

export async function deleteStoredJsonReplayArtifact({
  bucket,
  storedReplay,
}: {
  bucket: R2Bucket;
  storedReplay: StoredJsonReplayResult | null;
}): Promise<void> {
  if (
    !storedReplay ||
    storedReplay.kind !== "success" ||
    !("artifact" in storedReplay)
  ) {
    return;
  }

  await deleteReplayArtifact({
    bucket,
    artifact: storedReplay.artifact,
  });
}
