import crypto from "node:crypto";
import {
  getBillingReservation,
  mergeBillingReservationMeta,
  releaseBillingReservation,
  type BillingReservationRecord,
} from "./db";

const DIRECT_REQUEST_LEASE_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(
    process.env.DIRECT_REQUEST_LEASE_TIMEOUT_MS || String(10 * 60 * 1_000),
    10
  )
);
const DIRECT_REQUEST_LEASE_HEARTBEAT_MS = Math.max(
  10_000,
  Math.min(
    Math.floor(DIRECT_REQUEST_LEASE_TIMEOUT_MS / 3),
    Number.parseInt(
      process.env.DIRECT_REQUEST_LEASE_HEARTBEAT_MS || String(60_000),
      10
    )
  )
);
let stage5ApiInstanceId: string | null = null;

export type DirectRequestLease = {
  version: 1;
  instanceId: string;
  ownerId: string;
  acquiredAt: string;
  lastHeartbeatAt: string;
  timeoutMs: number;
};

export type DirectRequestOwnership = {
  version: 1;
  state: "worker-uploading" | "relay-owned";
  updatedAt: string;
};

type DuplicateReservationSnapshot = Pick<
  BillingReservationRecord,
  "status" | "meta" | "updated_at"
>;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseReservationMeta(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractDirectRequestLease(
  reservationMeta: unknown
): DirectRequestLease | null {
  const metaObject = asObject(reservationMeta);
  const leaseObject = asObject(metaObject?.directRequestLease);
  if (!leaseObject) {
    return null;
  }

  const version = Number(leaseObject.version);
  const instanceId =
    typeof leaseObject.instanceId === "string"
      ? leaseObject.instanceId.trim()
      : "";
  const ownerId =
    typeof leaseObject.ownerId === "string" ? leaseObject.ownerId.trim() : "";
  const acquiredAt =
    typeof leaseObject.acquiredAt === "string"
      ? leaseObject.acquiredAt.trim()
      : "";
  const lastHeartbeatAt =
    typeof leaseObject.lastHeartbeatAt === "string"
      ? leaseObject.lastHeartbeatAt.trim()
      : "";
  const timeoutMs = Number(leaseObject.timeoutMs);

  if (
    version !== 1 ||
    !instanceId ||
    !ownerId ||
    !acquiredAt ||
    !lastHeartbeatAt ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return null;
  }

  return {
    version: 1,
    instanceId,
    ownerId,
    acquiredAt,
    lastHeartbeatAt,
    timeoutMs,
  };
}

function extractDirectRequestOwnership(
  reservationMeta: unknown
): DirectRequestOwnership | null {
  const metaObject = asObject(reservationMeta);
  const ownershipObject = asObject(metaObject?.directRequestOwnership);
  if (!ownershipObject) {
    return null;
  }

  const version = Number(ownershipObject.version);
  const state =
    ownershipObject.state === "worker-uploading" ||
    ownershipObject.state === "relay-owned"
      ? ownershipObject.state
      : null;
  const updatedAt =
    typeof ownershipObject.updatedAt === "string"
      ? ownershipObject.updatedAt.trim()
      : "";

  if (version !== 1 || !state || !updatedAt) {
    return null;
  }

  return {
    version: 1,
    state,
    updatedAt,
  };
}

function hasPersistedDirectProgress(reservationMeta: unknown): boolean {
  const metaObject = asObject(reservationMeta);
  return (
    Object.prototype.hasOwnProperty.call(metaObject ?? {}, "directReplayResult") ||
    Object.prototype.hasOwnProperty.call(metaObject ?? {}, "pendingFinalize")
  );
}

function getLeaseHeartbeatAgeMs(
  lease: DirectRequestLease,
  now = Date.now()
): number {
  const heartbeatMs = parseTimestampMs(lease.lastHeartbeatAt);
  if (heartbeatMs === null) {
    return Number.POSITIVE_INFINITY;
  }
  return now - heartbeatMs;
}

function isDirectRequestLeaseFresh({
  reservationMeta,
  reservationUpdatedAt,
  now = Date.now(),
}: {
  reservationMeta?: unknown;
  reservationUpdatedAt?: string | null;
  now?: number;
}): boolean {
  const lease = extractDirectRequestLease(reservationMeta);
  if (lease) {
    return getLeaseHeartbeatAgeMs(lease, now) <= lease.timeoutMs;
  }

  const updatedAtMs = parseTimestampMs(reservationUpdatedAt);
  if (updatedAtMs === null) {
    return false;
  }
  return now - updatedAtMs <= DIRECT_REQUEST_LEASE_TIMEOUT_MS;
}

export function createDirectRequestLease(): DirectRequestLease {
  const now = new Date().toISOString();
  if (!stage5ApiInstanceId) {
    stage5ApiInstanceId = `stage5-api:${crypto.randomUUID()}`;
  }
  return {
    version: 1,
    instanceId: stage5ApiInstanceId,
    ownerId: crypto.randomUUID(),
    acquiredAt: now,
    lastHeartbeatAt: now,
    timeoutMs: DIRECT_REQUEST_LEASE_TIMEOUT_MS,
  };
}

function createDirectRequestOwnership(
  state: DirectRequestOwnership["state"]
): DirectRequestOwnership {
  return {
    version: 1,
    state,
    updatedAt: new Date().toISOString(),
  };
}

export function createWorkerUploadingOwnership(): DirectRequestOwnership {
  return createDirectRequestOwnership("worker-uploading");
}

export function createRelayOwnedOwnership(): DirectRequestOwnership {
  return createDirectRequestOwnership("relay-owned");
}

export function hasRelayOwnedDirectRequest(reservationMeta: unknown): boolean {
  return extractDirectRequestOwnership(reservationMeta)?.state === "relay-owned";
}

export function startDirectRequestLeaseHeartbeat({
  deviceId,
  requestKey,
  service,
  lease,
}: {
  deviceId: string;
  requestKey: string;
  service: string;
  lease: DirectRequestLease;
}): () => void {
  let active = true;
  let inFlight = false;
  let currentLease = lease;

  const persistHeartbeat = async (): Promise<void> => {
    if (!active || inFlight) {
      return;
    }

    inFlight = true;
    const nextLease: DirectRequestLease = {
      ...currentLease,
      lastHeartbeatAt: new Date().toISOString(),
    };
    try {
      const result = await mergeBillingReservationMeta({
        deviceId,
        service,
        requestKey,
        meta: {
          directRequestLease: nextLease,
        },
      });
      if (result.ok) {
        currentLease = nextLease;
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void persistHeartbeat();
  }, DIRECT_REQUEST_LEASE_HEARTBEAT_MS);

  return () => {
    active = false;
    clearInterval(timer);
  };
}

export async function resolveAbortReservationDisposition({
  deviceId,
  requestKey,
  service,
  graceMs = 1_500,
  pollIntervalMs = 100,
}: {
  deviceId: string;
  requestKey: string;
  service: string;
  graceMs?: number;
  pollIntervalMs?: number;
}): Promise<
  | { action: "preserve"; reservation: BillingReservationRecord | null }
  | { action: "release"; reservation: BillingReservationRecord | null }
> {
  const deadline = Date.now() + Math.max(0, graceMs);
  let keepPolling = true;
  let reservationToRelease: BillingReservationRecord | null = null;

  while (keepPolling) {
    const reservation = await getBillingReservation({
      deviceId,
      service,
      requestKey,
    });
    const reservationMeta = parseReservationMeta(reservation?.meta);
    reservationToRelease = reservation ?? null;

    if (!reservation) {
      return { action: "release", reservation: null };
    }

    if (reservation.status !== "reserved") {
      return { action: "preserve", reservation };
    }

    if (
      hasRelayOwnedDirectRequest(reservationMeta) ||
      hasPersistedDirectProgress(reservationMeta)
    ) {
      return { action: "preserve", reservation };
    }

    keepPolling = Date.now() < deadline;
    if (keepPolling) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(10, pollIntervalMs))
      );
    }
  }

  return { action: "release", reservation: reservationToRelease };
}

export async function recoverOrRestartDuplicateReservation({
  deviceId,
  requestKey,
  service,
  reservation,
  releaseReason,
  releaseMeta,
}: {
  deviceId: string;
  requestKey: string;
  service: string;
  reservation: DuplicateReservationSnapshot;
  releaseReason: string;
  releaseMeta?: unknown;
}): Promise<
  | { ok: true; action: "retry-reserve" }
  | { ok: true; action: "reservation-settled"; reservationMeta?: string | null }
  | { ok: false; status: 409 | 503; error: string }
> {
  if (reservation.status === "settled") {
    return {
      ok: true,
      action: "reservation-settled",
      reservationMeta: reservation.meta,
    };
  }

  if (reservation.status !== "reserved") {
    return {
      ok: false,
      status: 503,
      error: "Duplicate reservation is not active",
    };
  }

  if (
    isDirectRequestLeaseFresh({
      reservationMeta: reservation.meta,
      reservationUpdatedAt: reservation.updated_at,
    })
  ) {
    return {
      ok: false,
      status: 409,
      error: "Duplicate request is still in progress",
    };
  }

  const releaseResult = await releaseBillingReservation({
    deviceId,
    service,
    requestKey,
    reason: releaseReason,
    meta: {
      reason: "stale-direct-request-recovery",
      ...(releaseMeta && typeof releaseMeta === "object"
        ? (releaseMeta as Record<string, unknown>)
        : {}),
    },
  });
  if (!releaseResult.ok) {
    return {
      ok: false,
      status: 503,
      error: "Failed to recover duplicate reservation state",
    };
  }

  if (releaseResult.status === "released") {
    return { ok: true, action: "retry-reserve" };
  }

  if (!releaseResult.reservation || releaseResult.reservation.status === "released") {
    return { ok: true, action: "retry-reserve" };
  }

  if (releaseResult.reservation.status === "settled") {
    return {
      ok: true,
      action: "reservation-settled",
      reservationMeta: releaseResult.reservation.meta,
    };
  }

  return {
    ok: false,
    status: 409,
    error: "Duplicate request is still in progress",
  };
}

export async function persistDirectReplayOrRelease({
  deviceId,
  requestKey,
  service,
  replayResult,
  pendingFinalize,
  releaseReason,
}: {
  deviceId: string;
  requestKey: string;
  service: string;
  replayResult: unknown;
  pendingFinalize: unknown;
  releaseReason: string;
}): Promise<
  | { ok: true }
  | {
      ok: false;
      status: 409 | 503;
      error: string;
      details?: string;
      released: boolean;
    }
> {
  const persistResult = await mergeBillingReservationMeta({
    deviceId,
    service,
    requestKey,
    meta: {
      directReplayResult: replayResult,
      pendingFinalize,
    },
  });
  if (persistResult.ok) {
    return { ok: true };
  }

  let details: string | undefined;
  let released = false;
  const releaseResult = await releaseBillingReservation({
    deviceId,
    service,
    requestKey,
    reason: releaseReason,
    meta: {
      reason: "replay-persist-failed",
      persistError: persistResult.error,
    },
  });
  if (releaseResult.ok) {
    released =
      releaseResult.status === "released" ||
      releaseResult.reservation?.status === "released" ||
      releaseResult.reservation?.status === "settled";
  } else {
    details = "Reservation release also failed";
  }

  return {
    ok: false,
    status:
      persistResult.error === "missing-reservation" ||
      persistResult.error === "reservation-not-active"
        ? 409
        : 503,
    error: "Replay persistence failed",
    released,
    ...(details ? { details } : {}),
  };
}
