import {
  executeAtomicBatch,
  getDatabase,
} from "./db/core";
import {
  releaseBillingReservation,
  type BillingReservationRecord,
} from "./db/billing-reservations";
import {
  cleanupAbandonedPendingUploadTranscriptionJobs,
  cleanupDurableTranscriptionJobs,
  cleanupStaleProcessingTranscriptionJobs,
} from "./transcription-job-cleanup";
import {
  buildReplayArtifactKey,
  isReplayArtifactRef,
  type ReplayArtifactRef,
} from "./replay-artifacts";

const DIRECT_REPLAY_KEY_PATTERN =
  /^direct-replay\/v1\/[a-z0-9_-]+\/[a-f0-9]{40}\.json$/;
const MAX_CLEANUP_BATCH_SIZE = 500;

type DirectReplayCleanupMarker = {
  version: 1;
  artifact: ReplayArtifactRef;
  expiredAt: string;
};

type ReplayCleanupCandidate = {
  reservation: BillingReservationRecord;
  expectedMeta: string;
  claimedMeta: string;
  marker: DirectReplayCleanupMarker;
  needsClaim: boolean;
};

type InvalidReplayMetadataCandidate = {
  reservation: BillingReservationRecord;
  expectedMeta: string;
  cleanedMeta: string;
};

export interface ExpiredDirectReplayCleanupReport {
  selected: number;
  claimed: number;
  artifactsDeleted: number;
  metadataCleared: number;
  skippedInvalid: number;
  compareAndSwapMisses: number;
}

export interface StaleReservationCleanupReport {
  selected: number;
  released: number;
  refundedSpend: number;
  skippedChanged: number;
}

export interface BillingStorageCleanupReport {
  startedAt: string;
  finishedAt: string;
  replay: ExpiredDirectReplayCleanupReport;
  staleReservations: StaleReservationCleanupReport;
  transcriptionJobsDeleted: number;
  abandonedUploadsDeleted: number;
  staleProcessingJobsFailed: number;
  errors: string[];
}

function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.isFinite(value) ? Math.floor(Number(value)) : fallback;
  return parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function extractArtifact(
  value: unknown,
  reservation: BillingReservationRecord,
): ReplayArtifactRef | null {
  if (!isReplayArtifactRef(value)) {
    return null;
  }
  const expectedKey = buildReplayArtifactKey({
    service: reservation.service,
    deviceId: reservation.device_id,
    requestKey: reservation.request_key,
  });
  return DIRECT_REPLAY_KEY_PATTERN.test(value.key) && value.key === expectedKey
    ? value
    : null;
}

function extractReplayArtifact(
  meta: Record<string, unknown>,
  reservation: BillingReservationRecord,
): ReplayArtifactRef | null {
  const replay = asObject(meta.directReplayResult);
  if (replay?.kind !== "success") {
    return null;
  }
  return extractArtifact(replay.artifact, reservation);
}

function extractCleanupMarker(
  meta: Record<string, unknown>,
  reservation: BillingReservationRecord,
): DirectReplayCleanupMarker | null {
  const marker = asObject(meta.directReplayCleanup);
  const artifact = extractArtifact(marker?.artifact, reservation);
  const expiredAt =
    typeof marker?.expiredAt === "string" ? marker.expiredAt.trim() : "";
  if (marker?.version !== 1 || !artifact || !expiredAt) {
    return null;
  }
  return { version: 1, artifact, expiredAt };
}

function buildCleanupCandidate(
  reservation: BillingReservationRecord,
  expiredAt: string,
): ReplayCleanupCandidate | null {
  if (typeof reservation.meta !== "string") {
    return null;
  }
  const meta = parseMeta(reservation.meta);
  if (!meta) {
    return null;
  }

  const existingMarker = extractCleanupMarker(meta, reservation);
  if (existingMarker) {
    return {
      reservation,
      expectedMeta: reservation.meta,
      claimedMeta: reservation.meta,
      marker: existingMarker,
      needsClaim: false,
    };
  }

  const artifact = extractReplayArtifact(meta, reservation);
  if (!artifact) {
    return null;
  }

  const marker: DirectReplayCleanupMarker = {
    version: 1,
    artifact,
    expiredAt,
  };
  const claimedMeta = { ...meta };
  delete claimedMeta.directReplayResult;
  delete claimedMeta.pendingFinalize;
  claimedMeta.directReplayCleanup = marker;

  return {
    reservation,
    expectedMeta: reservation.meta,
    claimedMeta: JSON.stringify(claimedMeta),
    marker,
    needsClaim: true,
  };
}

function buildInvalidReplayMetadataCandidate(
  reservation: BillingReservationRecord,
  expiredAt: string,
): InvalidReplayMetadataCandidate | null {
  if (typeof reservation.meta !== "string") {
    return null;
  }
  const meta = parseMeta(reservation.meta);
  if (!meta) {
    return null;
  }

  const cleanedMeta = { ...meta };
  delete cleanedMeta.directReplayResult;
  delete cleanedMeta.pendingFinalize;
  delete cleanedMeta.directReplayCleanup;
  cleanedMeta.directReplayExpiredAt = expiredAt;
  return {
    reservation,
    expectedMeta: reservation.meta,
    cleanedMeta: JSON.stringify(cleanedMeta),
  };
}

async function listReplayCleanupRows({
  maxAgeHours,
  batchSize,
}: {
  maxAgeHours: number;
  batchSize: number;
}): Promise<BillingReservationRecord[]> {
  const db = getDatabase();
  const result = await db
    .prepare(
      `SELECT *
         FROM billing_reservations
        WHERE status = 'settled'
          AND (
            CASE WHEN json_valid(meta)
              THEN json_extract(meta, '$.directReplayCleanup.version')
              ELSE NULL
            END = 1
            OR (
              updated_at < datetime('now', ?)
              AND CASE WHEN json_valid(meta)
                THEN json_extract(
                  meta,
                  '$.directReplayResult.artifact.storage'
                )
                ELSE NULL
              END = 'r2'
            )
          )
        ORDER BY
          CASE
            WHEN CASE WHEN json_valid(meta)
              THEN json_extract(meta, '$.directReplayCleanup.version')
              ELSE NULL
            END = 1
            THEN 0 ELSE 1
          END,
          updated_at ASC
        LIMIT ?`,
    )
    .bind(`-${maxAgeHours} hours`, batchSize)
    .all();
  return Array.isArray(result?.results)
    ? (result.results as BillingReservationRecord[])
    : [];
}

function changesFromResult(result: any): number {
  return Number(result?.meta?.changes ?? result?.changes ?? 0) || 0;
}

export async function cleanupExpiredDirectReplayArtifacts({
  bucket,
  maxAgeHours = 24,
  batchSize = 200,
  now = new Date(),
}: {
  bucket: R2Bucket;
  maxAgeHours?: number;
  batchSize?: number;
  now?: Date;
}): Promise<ExpiredDirectReplayCleanupReport> {
  const safeMaxAgeHours = clampPositiveInteger(maxAgeHours, 24);
  const safeBatchSize = clampPositiveInteger(
    batchSize,
    200,
    MAX_CLEANUP_BATCH_SIZE,
  );
  const rows = await listReplayCleanupRows({
    maxAgeHours: safeMaxAgeHours,
    batchSize: safeBatchSize,
  });
  const report: ExpiredDirectReplayCleanupReport = {
    selected: rows.length,
    claimed: 0,
    artifactsDeleted: 0,
    metadataCleared: 0,
    skippedInvalid: 0,
    compareAndSwapMisses: 0,
  };
  const expiredAt = now.toISOString();
  const parsedCandidates: ReplayCleanupCandidate[] = [];
  const invalidCandidates: InvalidReplayMetadataCandidate[] = [];
  for (const row of rows) {
    const candidate = buildCleanupCandidate(row, expiredAt);
    if (candidate) {
      parsedCandidates.push(candidate);
      continue;
    }

    report.skippedInvalid += 1;
    const invalidCandidate = buildInvalidReplayMetadataCandidate(
      row,
      expiredAt,
    );
    if (invalidCandidate) {
      invalidCandidates.push(invalidCandidate);
    }
  }

  const db = getDatabase();
  if (invalidCandidates.length > 0) {
    const invalidResults = await executeAtomicBatch(
      invalidCandidates.map((candidate) =>
        db
          .prepare(
            `UPDATE billing_reservations
                SET meta = ?
              WHERE device_id = ?
                AND service = ?
                AND request_key = ?
                AND status = 'settled'
                AND meta = ?
                AND updated_at IS ?`,
          )
          .bind(
            candidate.cleanedMeta,
            candidate.reservation.device_id,
            candidate.reservation.service,
            candidate.reservation.request_key,
            candidate.expectedMeta,
            candidate.reservation.updated_at,
          ),
      ),
    );
    for (const result of invalidResults) {
      if (changesFromResult(result) === 1) {
        report.metadataCleared += 1;
      } else {
        report.compareAndSwapMisses += 1;
      }
    }
  }

  const newClaims = parsedCandidates.filter((candidate) => candidate.needsClaim);
  const claimedCandidates = parsedCandidates.filter(
    (candidate) => !candidate.needsClaim,
  );
  if (newClaims.length > 0) {
    const claimResults = await executeAtomicBatch(
      newClaims.map((candidate) =>
        db
          .prepare(
            `UPDATE billing_reservations
                SET meta = ?
              WHERE device_id = ?
                AND service = ?
                AND request_key = ?
                AND status = 'settled'
                AND meta = ?
                AND updated_at IS ?`,
          )
          .bind(
            candidate.claimedMeta,
            candidate.reservation.device_id,
            candidate.reservation.service,
            candidate.reservation.request_key,
            candidate.expectedMeta,
            candidate.reservation.updated_at,
          ),
      ),
    );
    for (let index = 0; index < newClaims.length; index += 1) {
      if (changesFromResult(claimResults[index]) === 1) {
        claimedCandidates.push(newClaims[index]);
        report.claimed += 1;
      } else {
        report.compareAndSwapMisses += 1;
      }
    }
  }

  if (claimedCandidates.length === 0) {
    return report;
  }

  const artifactKeys = [
    ...new Set(claimedCandidates.map((candidate) => candidate.marker.artifact.key)),
  ];
  await bucket.delete(artifactKeys);
  report.artifactsDeleted = artifactKeys.length;

  const clearResults = await executeAtomicBatch(
    claimedCandidates.map((candidate) => {
      const claimedMeta = parseMeta(candidate.claimedMeta) ?? {};
      delete claimedMeta.directReplayCleanup;
      claimedMeta.directReplayExpiredAt = candidate.marker.expiredAt;
      return db
        .prepare(
          `UPDATE billing_reservations
              SET meta = ?
            WHERE device_id = ?
              AND service = ?
              AND request_key = ?
              AND status = 'settled'
              AND meta = ?`,
        )
        .bind(
          JSON.stringify(claimedMeta),
          candidate.reservation.device_id,
          candidate.reservation.service,
          candidate.reservation.request_key,
          candidate.claimedMeta,
        );
    }),
  );
  for (const result of clearResults) {
    if (changesFromResult(result) === 1) {
      report.metadataCleared += 1;
    } else {
      report.compareAndSwapMisses += 1;
    }
  }

  return report;
}

async function listStaleNoProgressReservations({
  maxAgeHours,
  batchSize,
}: {
  maxAgeHours: number;
  batchSize: number;
}): Promise<BillingReservationRecord[]> {
  const db = getDatabase();
  const result = await db
    .prepare(
      `SELECT *
         FROM billing_reservations
        WHERE status = 'reserved'
          AND updated_at < datetime('now', ?)
          AND CASE
            WHEN meta IS NULL THEN 1
            WHEN json_valid(meta) THEN
              CASE
                WHEN json_type(meta, '$.directReplayResult') IS NULL
                 AND (
                   json_type(meta, '$.pendingFinalize') IS NULL
                   OR json_type(meta, '$.pendingFinalize') = 'null'
                 )
                THEN 1 ELSE 0
              END
            ELSE 0
          END = 1
        ORDER BY updated_at ASC
        LIMIT ?`,
    )
    .bind(`-${maxAgeHours} hours`, batchSize)
    .all();
  return Array.isArray(result?.results)
    ? (result.results as BillingReservationRecord[])
    : [];
}

export async function cleanupStaleNoProgressBillingReservations({
  maxAgeHours = 24,
  batchSize = 200,
  now = new Date(),
}: {
  maxAgeHours?: number;
  batchSize?: number;
  now?: Date;
} = {}): Promise<StaleReservationCleanupReport> {
  const safeMaxAgeHours = clampPositiveInteger(maxAgeHours, 24);
  const safeBatchSize = clampPositiveInteger(
    batchSize,
    200,
    MAX_CLEANUP_BATCH_SIZE,
  );
  const reservations = await listStaleNoProgressReservations({
    maxAgeHours: safeMaxAgeHours,
    batchSize: safeBatchSize,
  });
  const report: StaleReservationCleanupReport = {
    selected: reservations.length,
    released: 0,
    refundedSpend: 0,
    skippedChanged: 0,
  };

  for (const reservation of reservations) {
    const result = await releaseBillingReservation({
      deviceId: reservation.device_id,
      service: reservation.service,
      requestKey: reservation.request_key,
      reason: "STALE_RESERVATION_CLEANUP",
      expectedUpdatedAt: reservation.updated_at,
      meta: {
        releaseReason: "stale-no-progress-reservation",
        expiredAt: now.toISOString(),
      },
    });
    if (result.ok && result.status === "released") {
      report.released += 1;
      report.refundedSpend += result.refundedSpend;
    } else {
      report.skippedChanged += 1;
    }
  }

  return report;
}

export async function runBillingStorageCleanup({
  bucket,
  directReplayMaxAgeHours = 24,
  staleReservationMaxAgeHours = 24,
  transcriptionJobMaxAgeHours = 24,
  batchSize = 200,
  now = new Date(),
}: {
  bucket: R2Bucket;
  directReplayMaxAgeHours?: number;
  staleReservationMaxAgeHours?: number;
  transcriptionJobMaxAgeHours?: number;
  batchSize?: number;
  now?: Date;
}): Promise<BillingStorageCleanupReport> {
  const safeDirectReplayMaxAgeHours = clampPositiveInteger(
    directReplayMaxAgeHours,
    24,
  );
  const safeStaleReservationMaxAgeHours = clampPositiveInteger(
    staleReservationMaxAgeHours,
    24,
  );
  const safeTranscriptionJobMaxAgeHours = clampPositiveInteger(
    transcriptionJobMaxAgeHours,
    24,
  );
  const safeBatchSize = clampPositiveInteger(
    batchSize,
    200,
    MAX_CLEANUP_BATCH_SIZE,
  );
  const report: BillingStorageCleanupReport = {
    startedAt: now.toISOString(),
    finishedAt: "",
    replay: {
      selected: 0,
      claimed: 0,
      artifactsDeleted: 0,
      metadataCleared: 0,
      skippedInvalid: 0,
      compareAndSwapMisses: 0,
    },
    staleReservations: {
      selected: 0,
      released: 0,
      refundedSpend: 0,
      skippedChanged: 0,
    },
    transcriptionJobsDeleted: 0,
    abandonedUploadsDeleted: 0,
    staleProcessingJobsFailed: 0,
    errors: [],
  };

  try {
    report.replay = await cleanupExpiredDirectReplayArtifacts({
      bucket,
      maxAgeHours: safeDirectReplayMaxAgeHours,
      batchSize: safeBatchSize,
      now,
    });
  } catch (error: any) {
    report.errors.push(`direct-replay: ${error?.message || String(error)}`);
  }

  try {
    report.staleReservations =
      await cleanupStaleNoProgressBillingReservations({
        maxAgeHours: safeStaleReservationMaxAgeHours,
        batchSize: safeBatchSize,
        now,
      });
  } catch (error: any) {
    report.errors.push(`stale-reservations: ${error?.message || String(error)}`);
  }

  try {
    report.abandonedUploadsDeleted =
      await cleanupAbandonedPendingUploadTranscriptionJobs({
        bucket,
        maxAgeHours: safeTranscriptionJobMaxAgeHours,
        batchSize: safeBatchSize,
      });
  } catch (error: any) {
    report.errors.push(`abandoned-uploads: ${error?.message || String(error)}`);
  }

  try {
    report.staleProcessingJobsFailed =
      await cleanupStaleProcessingTranscriptionJobs({
        bucket,
        maxAgeHours: safeTranscriptionJobMaxAgeHours,
        batchSize: safeBatchSize,
        now,
      });
  } catch (error: any) {
    report.errors.push(`stale-processing-jobs: ${error?.message || String(error)}`);
  }

  try {
    report.transcriptionJobsDeleted = await cleanupDurableTranscriptionJobs({
      bucket,
      maxAgeHours: safeTranscriptionJobMaxAgeHours,
      batchSize: safeBatchSize,
    });
  } catch (error: any) {
    report.errors.push(`transcription-jobs: ${error?.message || String(error)}`);
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
