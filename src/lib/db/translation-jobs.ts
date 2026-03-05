import { getDatabase } from "./core";

export interface TranslationJobRecord {
  job_id: string;
  device_id: string;
  status: string;
  model: string | null;
  payload: string | null;
  relay_job_id: string | null;
  result: string | null;
  error: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  credited: number;
  created_at: string;
  updated_at: string;
}

export interface RelayTranslationJobRecord {
  relay_job_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const createTranslationJob = async ({
  jobId,
  deviceId,
  model,
  payload,
  relayJobId,
}: {
  jobId: string;
  deviceId: string;
  model: string;
  payload: Record<string, unknown>;
  relayJobId?: string | null;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO translation_jobs (job_id, device_id, status, model, payload, relay_job_id, created_at, updated_at)
    VALUES (?, ?, 'queued', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(job_id) DO UPDATE SET
      device_id = excluded.device_id,
      status = 'queued',
      model = excluded.model,
      payload = excluded.payload,
      relay_job_id = excluded.relay_job_id,
      error = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);

  await stmt
    .bind(jobId, deviceId, model, JSON.stringify(payload ?? {}), relayJobId ?? null)
    .run();
};

export const upsertRelayTranslationJob = async ({
  relayJobId,
  status,
  result,
  error,
}: {
  relayJobId: string;
  status: RelayTranslationJobRecord["status"];
  result?: unknown;
  error?: string | null;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO relay_translation_jobs (relay_job_id, status, result, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(relay_job_id) DO UPDATE SET
      status = excluded.status,
      result = excluded.result,
      error = excluded.error,
      updated_at = CURRENT_TIMESTAMP
  `);

  await stmt
    .bind(
      relayJobId,
      status,
      result == null ? null : JSON.stringify(result),
      error ?? null
    )
    .run();
};

export const getRelayTranslationJob = async ({
  relayJobId,
}: {
  relayJobId: string;
}): Promise<RelayTranslationJobRecord | null> => {
  const db = getDatabase();

  const stmt = db.prepare(
    "SELECT * FROM relay_translation_jobs WHERE relay_job_id = ?"
  );
  const result = await stmt.bind(relayJobId).first();
  return (result as RelayTranslationJobRecord) ?? null;
};

export const cleanupOldRelayTranslationJobs = async ({
  maxAgeHours = 24,
}: {
  maxAgeHours?: number;
} = {}): Promise<number> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM relay_translation_jobs
     WHERE created_at < datetime('now', '-' || ? || ' hours')
  `);

  const res = await stmt.bind(maxAgeHours).run();
  return res.meta?.changes ?? 0;
};

export const deleteTranslationJob = async ({
  jobId,
}: {
  jobId: string;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare("DELETE FROM translation_jobs WHERE job_id = ?");
  await stmt.bind(jobId).run();
};

export const getTranslationJob = async ({
  jobId,
}: {
  jobId: string;
}): Promise<TranslationJobRecord | null> => {
  const db = getDatabase();

  const stmt = db.prepare(
    "SELECT * FROM translation_jobs WHERE job_id = ?"
  );
  const result = await stmt.bind(jobId).first();
  return (result as TranslationJobRecord) ?? null;
};

export const listTranslationJobsForReconciliation = async ({
  staleMinutes = 30,
  limit = 200,
}: {
  staleMinutes?: number;
  limit?: number;
} = {}): Promise<TranslationJobRecord[]> => {
  const db = getDatabase();

  const safeStaleMinutes = Math.max(1, Math.floor(staleMinutes));
  const safeLimit = Math.max(1, Math.floor(limit));
  const stmt = db.prepare(`
    SELECT *
      FROM translation_jobs
     WHERE (
            status IN ('queued', 'processing', 'dispatching')
        AND updated_at < datetime('now', '-' || ? || ' minutes')
           )
        OR (
             status = 'completed'
         AND credited = 0
           )
     ORDER BY updated_at ASC
     LIMIT ?
  `);
  const result = await stmt.bind(safeStaleMinutes, safeLimit).all();
  return (result.results as TranslationJobRecord[]) || [];
};

export const setTranslationJobProcessing = async ({
  jobId,
  relayJobId,
}: {
  jobId: string;
  relayJobId: string | null;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE translation_jobs
       SET status = 'processing',
           relay_job_id = ?,
           error = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(relayJobId ?? null, jobId).run();
};

export const resetTranslationJobRelay = async ({
  jobId,
}: {
  jobId: string;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE translation_jobs
       SET status = 'queued',
           relay_job_id = NULL,
           error = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(jobId).run();
};

export const setTranslationJobQueuedWithRelay = async ({
  jobId,
  relayJobId,
}: {
  jobId: string;
  relayJobId: string;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE translation_jobs
       SET status = 'queued',
           relay_job_id = ?,
           error = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(relayJobId, jobId).run();
};

export const countTranslationJobsInFlight = async (): Promise<number> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT COUNT(1) AS count
      FROM translation_jobs
     WHERE status IN ('processing', 'dispatching')
  `);

  const row = (await stmt.first()) as { count?: number | string } | null;
  const raw = row?.count;
  const parsed = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const countQueuedTranslationJobs = async (): Promise<number> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT COUNT(1) AS count
      FROM translation_jobs
     WHERE status = 'queued'
       AND relay_job_id IS NULL
  `);

  const row = (await stmt.first()) as { count?: number | string } | null;
  const raw = row?.count;
  const parsed = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const countActiveTranslationJobsForDevice = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<number> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT COUNT(1) AS count
      FROM translation_jobs
     WHERE device_id = ?
       AND status IN ('queued', 'dispatching', 'processing')
  `);

  const row = (await stmt.bind(deviceId).first()) as
    | { count?: number | string }
    | null;
  const raw = row?.count;
  const parsed = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const countRecentTranslationJobsForDevice = async ({
  deviceId,
  windowSeconds,
}: {
  deviceId: string;
  windowSeconds: number;
}): Promise<number> => {
  const db = getDatabase();

  const safeWindowSeconds = Math.max(1, Math.floor(windowSeconds));
  const stmt = db.prepare(`
    SELECT COUNT(1) AS count
      FROM translation_jobs
     WHERE device_id = ?
       AND created_at >= datetime('now', '-' || ? || ' seconds')
  `);

  const row = (await stmt.bind(deviceId, safeWindowSeconds).first()) as
    | { count?: number | string }
    | null;
  const raw = row?.count;
  const parsed = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const getTranslationJobStatusCounts = async (): Promise<
  Array<{ status: string; count: number }>
> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT status, COUNT(1) AS count
      FROM translation_jobs
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

export const listQueuedTranslationJobs = async ({
  limit = 100,
}: {
  limit?: number;
} = {}): Promise<TranslationJobRecord[]> => {
  const db = getDatabase();

  const safeLimit = Math.max(1, Math.floor(limit));
  const stmt = db.prepare(`
    SELECT *
      FROM translation_jobs
     WHERE status = 'queued'
       AND relay_job_id IS NULL
     ORDER BY created_at ASC
     LIMIT ?
  `);
  const result = await stmt.bind(safeLimit).all();
  return (result.results as TranslationJobRecord[]) || [];
};

export const claimTranslationJobDispatch = async ({
  jobId,
  maxInFlight,
}: {
  jobId: string;
  maxInFlight?: number;
}): Promise<boolean> => {
  const db = getDatabase();

  const hasInFlightCap =
    typeof maxInFlight === "number" && Number.isFinite(maxInFlight);
  const safeMaxInFlight = hasInFlightCap
    ? Math.max(1, Math.floor(maxInFlight))
    : null;

  const stmt = hasInFlightCap
    ? db.prepare(`
    UPDATE translation_jobs
       SET status = 'dispatching',
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
       AND status = 'queued'
       AND relay_job_id IS NULL
       AND (
         SELECT COUNT(1)
           FROM translation_jobs
          WHERE status IN ('processing', 'dispatching')
       ) < ?
  `)
    : db.prepare(`
    UPDATE translation_jobs
       SET status = 'dispatching',
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
       AND status = 'queued'
       AND relay_job_id IS NULL
  `);

  const res = hasInFlightCap
    ? await stmt.bind(jobId, safeMaxInFlight).run()
    : await stmt.bind(jobId).run();
  return (res.meta?.changes ?? 0) > 0;
};

export const storeTranslationJobResult = async ({
  jobId,
  result,
  promptTokens,
  completionTokens,
}: {
  jobId: string;
  result: any;
  promptTokens?: number | null;
  completionTokens?: number | null;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE translation_jobs
       SET status = 'completed',
           result = ?,
           error = NULL,
           prompt_tokens = ?,
           completion_tokens = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt
    .bind(
      JSON.stringify(result ?? {}),
      promptTokens ?? null,
      completionTokens ?? null,
      jobId
    )
    .run();
};

export const storeTranslationJobError = async ({
  jobId,
  message,
}: {
  jobId: string;
  message: string;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE translation_jobs
       SET status = 'failed',
           error = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(message, jobId).run();
};

export const markTranslationJobCredited = async ({
  jobId,
}: {
  jobId: string;
}): Promise<void> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE translation_jobs
       SET credited = 1,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(jobId).run();
};
