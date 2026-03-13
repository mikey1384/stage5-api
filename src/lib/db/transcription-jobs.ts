import { getDatabase } from "./core";

// ============================================================================
// Transcription Jobs (R2 upload flow)
// ============================================================================

export interface TranscriptionJobRecord {
  job_id: string;
  device_id: string;
  client_request_key: string | null;
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
  clientRequestKey,
  fileKey,
  language,
  durationSeconds,
}: {
  jobId: string;
  deviceId: string;
  clientRequestKey?: string | null;
  fileKey: string;
  language?: string;
  durationSeconds?: number | null;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO transcription_jobs (
      job_id,
      device_id,
      client_request_key,
      status,
      file_key,
      language,
      duration_seconds,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'pending_upload', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  await stmt
    .bind(
      jobId,
      deviceId,
      clientRequestKey ?? null,
      fileKey,
      language ?? null,
      durationSeconds ?? null
    )
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

export const getTranscriptionJobByClientRequestKey = async ({
  deviceId,
  clientRequestKey,
}: {
  deviceId: string;
  clientRequestKey: string;
}): Promise<TranscriptionJobRecord | null> => {
  const normalizedKey = clientRequestKey.trim();
  if (!normalizedKey) {
    return null;
  }

  const db = getDatabase();
  const result = await db
    .prepare(
      `SELECT *
         FROM transcription_jobs
        WHERE device_id = ?
          AND client_request_key = ?
        LIMIT 1`
    )
    .bind(deviceId, normalizedKey)
    .first();
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

export const clearFailedTranscriptionJobClientRequestKey = async ({
  jobId,
  clientRequestKey,
}: {
  jobId: string;
  clientRequestKey: string;
}): Promise<boolean> => {
  const normalizedJobId = String(jobId || "").trim();
  const normalizedKey = String(clientRequestKey || "").trim();
  if (!normalizedJobId || !normalizedKey) {
    return false;
  }

  const db = getDatabase();
  const result = await db
    .prepare(
      `UPDATE transcription_jobs
          SET client_request_key = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?
          AND status = 'failed'
          AND client_request_key = ?`
    )
    .bind(normalizedJobId, normalizedKey)
    .run();

  return (result.meta?.changes ?? 0) > 0;
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

export const listOldTranscriptionJobs = async ({
  maxAgeHours = 24,
  limit = 200,
  statuses,
  excludeJobIds,
}: {
  maxAgeHours?: number;
  limit?: number;
  statuses?: Array<TranscriptionJobRecord["status"]>;
  excludeJobIds?: string[];
} = {}): Promise<TranscriptionJobRecord[]> => {
  const db = getDatabase();
  const safeMaxAgeHours = Math.max(1, Math.floor(maxAgeHours));
  const safeLimit = Math.max(1, Math.floor(limit));
  const normalizedStatuses = (statuses || [])
    .map(status => String(status || "").trim())
    .filter(Boolean);
  const statusPlaceholders = normalizedStatuses.map(() => "?").join(", ");
  const statusClause =
    normalizedStatuses.length > 0
      ? ` AND status IN (${statusPlaceholders})`
      : "";
  const normalizedExcludedIds = (excludeJobIds || [])
    .map(jobId => String(jobId || "").trim())
    .filter(Boolean);
  const excludedIdPlaceholders = normalizedExcludedIds.map(() => "?").join(", ");
  const excludedIdClause =
    normalizedExcludedIds.length > 0
      ? ` AND job_id NOT IN (${excludedIdPlaceholders})`
      : "";
  const stmt = db.prepare(`
    SELECT *
      FROM transcription_jobs
     WHERE created_at < datetime('now', '-' || ? || ' hours')
           ${statusClause}
           ${excludedIdClause}
     ORDER BY created_at ASC
     LIMIT ?
  `);
  const result = await stmt
    .bind(
      safeMaxAgeHours,
      ...normalizedStatuses,
      ...normalizedExcludedIds,
      safeLimit,
    )
    .all();
  return (result.results as TranscriptionJobRecord[]) || [];
};

export const deleteTranscriptionJobsByIds = async ({
  jobIds,
}: {
  jobIds: string[];
}): Promise<number> => {
  const normalizedIds = jobIds
    .map(jobId => String(jobId || '').trim())
    .filter(Boolean);
  if (normalizedIds.length === 0) {
    return 0;
  }

  const db = getDatabase();
  const placeholders = normalizedIds.map(() => '?').join(', ');
  const stmt = db.prepare(`
    DELETE FROM transcription_jobs
     WHERE job_id IN (${placeholders})
  `);
  const res = await stmt.bind(...normalizedIds).run();
  return res.meta?.changes ?? 0;
};
