import { getDatabase } from "./core";

// ============================================================================
// Transcription Jobs (R2 upload flow)
// ============================================================================

export interface TranscriptionJobRecord {
  job_id: string;
  device_id: string;
  status: "pending_upload" | "processing" | "completed" | "failed";
  file_key: string | null;
  language: string | null;
  result: string | null;
  error: string | null;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
}

export const createTranscriptionJob = async ({
  jobId,
  deviceId,
  fileKey,
  language,
  durationSeconds,
}: {
  jobId: string;
  deviceId: string;
  fileKey: string;
  language?: string;
  durationSeconds?: number | null;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO transcription_jobs (
      job_id,
      device_id,
      status,
      file_key,
      language,
      duration_seconds,
      created_at,
      updated_at
    )
    VALUES (?, ?, 'pending_upload', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  await stmt
    .bind(jobId, deviceId, fileKey, language ?? null, durationSeconds ?? null)
    .run();
};

export const getTranscriptionJob = async ({
  jobId,
}: {
  jobId: string;
}): Promise<TranscriptionJobRecord | null> => {
  const db = getDatabase();

  const stmt = db.prepare("SELECT * FROM transcription_jobs WHERE job_id = ?");
  const result = await stmt.bind(jobId).first();
  return (result as TranscriptionJobRecord) ?? null;
};

export const listTranscriptionJobsForReconciliation = async ({
  pendingUploadStaleMinutes = 120,
  processingStaleMinutes = 60,
  limit = 200,
}: {
  pendingUploadStaleMinutes?: number;
  processingStaleMinutes?: number;
  limit?: number;
} = {}): Promise<TranscriptionJobRecord[]> => {
  const db = getDatabase();

  const safePendingUploadMinutes = Math.max(
    1,
    Math.floor(pendingUploadStaleMinutes)
  );
  const safeProcessingMinutes = Math.max(
    1,
    Math.floor(processingStaleMinutes)
  );
  const safeLimit = Math.max(1, Math.floor(limit));

  const stmt = db.prepare(`
    SELECT *
      FROM transcription_jobs
     WHERE (
             status = 'pending_upload'
         AND updated_at < datetime('now', '-' || ? || ' minutes')
           )
        OR (
             status = 'processing'
         AND updated_at < datetime('now', '-' || ? || ' minutes')
           )
        OR (
             status = 'completed'
         AND (result IS NULL OR trim(result) = '')
           )
     ORDER BY updated_at ASC
     LIMIT ?
  `);

  const result = await stmt
    .bind(safePendingUploadMinutes, safeProcessingMinutes, safeLimit)
    .all();
  return (result.results as TranscriptionJobRecord[]) || [];
};

export const getTranscriptionJobStatusCounts = async (): Promise<
  Array<{ status: string; count: number }>
> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT status, COUNT(1) AS count
      FROM transcription_jobs
     GROUP BY status
     ORDER BY status ASC
  `);
  const result = await stmt.all();
  return ((result.results || []) as Array<{ status: string; count: number | string }>).map(
    (row) => ({
      status: row.status,
      count:
        typeof row.count === "number"
          ? row.count
          : Number.parseInt(String(row.count), 10) || 0,
    })
  );
};

export const setTranscriptionJobProcessing = async ({
  jobId,
}: {
  jobId: string;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE transcription_jobs
       SET status = 'processing',
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(jobId).run();
};

export const storeTranscriptionJobResult = async ({
  jobId,
  result,
  durationSeconds,
}: {
  jobId: string;
  result: any;
  durationSeconds?: number | null;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE transcription_jobs
       SET status = 'completed',
           result = ?,
           duration_seconds = ?,
           error = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt
    .bind(JSON.stringify(result ?? {}), durationSeconds ?? null, jobId)
    .run();
};

export const storeTranscriptionJobError = async ({
  jobId,
  message,
}: {
  jobId: string;
  message: string;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE transcription_jobs
       SET status = 'failed',
           error = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(message, jobId).run();
};

export const cleanupOldTranscriptionJobs = async ({
  maxAgeHours = 24,
}: {
  maxAgeHours?: number;
} = {}): Promise<number> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM transcription_jobs
     WHERE created_at < datetime('now', '-' || ? || ' hours')
  `);

  const res = await stmt.bind(maxAgeHours).run();
  return res.meta?.changes ?? 0;
};
