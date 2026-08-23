import {
  deleteAbandonedPendingUploadTranscriptionJobIfUnchanged,
  deleteTerminalTranscriptionJobIfUnchanged,
  failProcessingTranscriptionJobIfUnchanged,
  listAbandonedPendingUploadTranscriptionJobs,
  listOldTranscriptionJobs,
} from "./db/transcription-jobs";
import { releaseBillingReservation } from "./db/billing-reservations";
import {
  buildReplayArtifactKey,
  deleteReplayArtifact,
  isReplayArtifactRef,
} from "./replay-artifacts";
import {
  buildR2TranscriptionReservationKey,
  TRANSCRIPTION_R2_RESERVATION_SCOPE,
} from "./transcription-billing";
import { generateFileKey } from "./r2-config";

const MAX_CLEANUP_BATCH_SIZE = 500;

function boundedBatchSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 200;
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_CLEANUP_BATCH_SIZE));
}

function parseStoredResult(raw: string | null | undefined): unknown {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cleanupStoredTranscriptionResultArtifact({
  bucket,
  deviceId,
  jobId,
  storedResult,
}: {
  bucket: R2Bucket;
  deviceId: string;
  jobId: string;
  storedResult: string | null | undefined;
}): Promise<void> {
  const parsed = parseStoredResult(storedResult);
  const expectedKey = buildReplayArtifactKey({
    service: "transcription-job-result",
    deviceId,
    requestKey: jobId,
  });
  if (!isReplayArtifactRef(parsed) || parsed.key !== expectedKey) {
    return;
  }

  try {
    await deleteReplayArtifact({
      bucket,
      artifact: parsed,
    });
  } catch (error: any) {
    const message = String(error?.message || error || "");
    if (!/not found/i.test(message)) {
      throw error;
    }
  }
}

async function cleanupStoredTranscriptionAudio({
  bucket,
  deviceId,
  jobId,
  fileKey,
}: {
  bucket: R2Bucket;
  deviceId: string;
  jobId: string;
  fileKey: string | null | undefined;
}): Promise<void> {
  const normalizedKey = String(fileKey || "").trim();
  if (normalizedKey !== generateFileKey(deviceId, jobId)) {
    return;
  }
  await bucket.delete(normalizedKey);
}

export async function cleanupDurableTranscriptionJobs({
  bucket,
  maxAgeHours = 24,
  batchSize = 200,
}: {
  bucket: R2Bucket;
  maxAgeHours?: number;
  batchSize?: number;
}): Promise<number> {
  const safeBatchSize = boundedBatchSize(batchSize);
  let deleted = 0;
  const jobs = await listOldTranscriptionJobs({
    maxAgeHours,
    limit: safeBatchSize,
    statuses: ["completed", "failed"],
  });

  for (const job of jobs) {
    const deletedRow = await deleteTerminalTranscriptionJobIfUnchanged({
      jobId: job.job_id,
      status: job.status as "completed" | "failed",
      expectedUpdatedAt: job.updated_at,
    });
    if (!deletedRow) {
      continue;
    }

    deleted += 1;

    try {
      await cleanupStoredTranscriptionAudio({
        bucket,
        deviceId: job.device_id,
        jobId: job.job_id,
        fileKey: job.file_key,
      });
      await cleanupStoredTranscriptionResultArtifact({
        bucket,
        deviceId: job.device_id,
        jobId: job.job_id,
        storedResult: job.result,
      });
    } catch (error) {
      console.warn(
        `[transcription-cleanup] Deleted durable job ${job.job_id} but failed to remove one or more stored artifacts:`,
        error,
      );
    }
  }

  return deleted;
}

export async function cleanupAbandonedPendingUploadTranscriptionJobs({
  bucket,
  maxAgeHours = 24,
  batchSize = 200,
}: {
  bucket: R2Bucket;
  maxAgeHours?: number;
  batchSize?: number;
}): Promise<number> {
  const safeBatchSize = boundedBatchSize(batchSize);
  let deleted = 0;
  const jobs = await listAbandonedPendingUploadTranscriptionJobs({
    maxAgeHours,
    limit: safeBatchSize,
    reservationRequestKeyPrefix: `${TRANSCRIPTION_R2_RESERVATION_SCOPE}:`,
  });

  for (const job of jobs) {
    const deletedRow =
      await deleteAbandonedPendingUploadTranscriptionJobIfUnchanged({
        jobId: job.job_id,
        deviceId: job.device_id,
        expectedUpdatedAt: job.updated_at,
        reservationRequestKey: buildR2TranscriptionReservationKey(job.job_id),
      });
    if (!deletedRow) {
      continue;
    }

    deleted += 1;

    try {
      await cleanupStoredTranscriptionAudio({
        bucket,
        deviceId: job.device_id,
        jobId: job.job_id,
        fileKey: job.file_key,
      });
    } catch (error) {
      console.warn(
        `[transcription-cleanup] Deleted abandoned pending_upload job ${job.job_id} but failed to remove its stored audio:`,
        error,
      );
    }
  }

  return deleted;
}

export async function cleanupStaleProcessingTranscriptionJobs({
  bucket,
  maxAgeHours = 24,
  batchSize = 200,
  now = new Date(),
}: {
  bucket: R2Bucket;
  maxAgeHours?: number;
  batchSize?: number;
  now?: Date;
}): Promise<number> {
  const jobs = await listOldTranscriptionJobs({
    maxAgeHours,
    limit: boundedBatchSize(batchSize),
    statuses: ["processing"],
  });
  let failed = 0;

  for (const job of jobs) {
    const reason = "storage-cleanup:processing-timeout";
    const changed = await failProcessingTranscriptionJobIfUnchanged({
      jobId: job.job_id,
      expectedUpdatedAt: job.updated_at,
      error: reason,
    });
    if (!changed) {
      continue;
    }

    failed += 1;
    await releaseBillingReservation({
      deviceId: job.device_id,
      service: "transcription",
      requestKey: buildR2TranscriptionReservationKey(job.job_id),
      reason: "TRANSCRIBE",
      meta: {
        reason,
        source: "storage-cleanup",
        jobId: job.job_id,
        expiredAt: now.toISOString(),
      },
    });
    await cleanupStoredTranscriptionAudio({
      bucket,
      deviceId: job.device_id,
      jobId: job.job_id,
      fileKey: job.file_key,
    });
  }

  return failed;
}
