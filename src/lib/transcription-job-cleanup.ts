import { confirmExistingBillingReservation } from "./db/billing-reservations";
import {
  deleteTranscriptionJobsByIds,
  listOldTranscriptionJobs,
} from "./db/transcription-jobs";
import {
  deleteReplayArtifact,
  isReplayArtifactRef,
} from "./replay-artifacts";
import { buildR2TranscriptionReservationKey } from "./transcription-billing";

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
  storedResult,
}: {
  bucket: R2Bucket;
  storedResult: string | null | undefined;
}): Promise<void> {
  const parsed = parseStoredResult(storedResult);
  if (!isReplayArtifactRef(parsed)) {
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
  fileKey,
}: {
  bucket: R2Bucket;
  fileKey: string | null | undefined;
}): Promise<void> {
  const normalizedKey = String(fileKey || "").trim();
  if (!normalizedKey) {
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
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  let deleted = 0;
  let jobs = await listOldTranscriptionJobs({
    maxAgeHours,
    limit: safeBatchSize,
    statuses: ["completed", "failed"],
  });

  while (jobs.length > 0) {

    for (const job of jobs) {
      const deletedRows = await deleteTranscriptionJobsByIds({
        jobIds: [job.job_id],
      });
      if (deletedRows !== 1) {
        continue;
      }

      deleted += 1;

      try {
        await cleanupStoredTranscriptionAudio({
          bucket,
          fileKey: job.file_key,
        });
        await cleanupStoredTranscriptionResultArtifact({
          bucket,
          storedResult: job.result,
        });
      } catch (error) {
        console.warn(
          `[transcription-cleanup] Deleted durable job ${job.job_id} but failed to remove one or more stored artifacts:`,
          error,
        );
      }
    }

    if (jobs.length < safeBatchSize) {
      return deleted;
    }

    jobs = await listOldTranscriptionJobs({
      maxAgeHours,
      limit: safeBatchSize,
      statuses: ["completed", "failed"],
    });
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
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  let deleted = 0;
  const skippedReservedJobIds = new Set<string>();
  let jobs = await listOldTranscriptionJobs({
    maxAgeHours,
    limit: safeBatchSize,
    statuses: ["pending_upload"],
    excludeJobIds: Array.from(skippedReservedJobIds),
  });

  while (jobs.length > 0) {

    for (const job of jobs) {
      const reservation = await confirmExistingBillingReservation({
        deviceId: job.device_id,
        service: "transcription",
        requestKey: buildR2TranscriptionReservationKey(job.job_id),
      });
      if (reservation.ok) {
        skippedReservedJobIds.add(job.job_id);
        continue;
      }

      const deletedRows = await deleteTranscriptionJobsByIds({
        jobIds: [job.job_id],
      });
      if (deletedRows !== 1) {
        continue;
      }

      deleted += 1;

      try {
        await cleanupStoredTranscriptionAudio({
          bucket,
          fileKey: job.file_key,
        });
      } catch (error) {
        console.warn(
          `[transcription-cleanup] Deleted abandoned pending_upload job ${job.job_id} but failed to remove its stored audio:`,
          error,
        );
      }
    }

    if (jobs.length < safeBatchSize) {
      return deleted;
    }

    jobs = await listOldTranscriptionJobs({
      maxAgeHours,
      limit: safeBatchSize,
      statuses: ["pending_upload"],
      excludeJobIds: Array.from(skippedReservedJobIds),
    });
  }

  return deleted;
}
