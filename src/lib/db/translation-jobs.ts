import {
  buildRollbackIfNoChangesStatement,
  executeAtomicBatch,
  getDatabase,
  hasAtomicBatch,
  isRollbackIfNoChangesError,
  runInTransaction,
} from "./core";

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

type TranslationJobSettlementState = {
  credited: number | string;
};

type BillingReservationState = {
  reserved_spend: number | string;
  settled_spend?: number | string | null;
  status: "reserved" | "settled" | "released";
  meta?: string | null;
};

function parseReservationMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildTranslationFailureReleaseMeta({
  existingMetaRaw,
  failureMessage,
  billingMeta,
}: {
  existingMetaRaw: string | null | undefined;
  failureMessage: string;
  billingMeta?: unknown;
}): string {
  return JSON.stringify({
    ...parseReservationMeta(existingMetaRaw),
    releaseReason: "translation-job-failed",
    failureMessage,
    ...(billingMeta && typeof billingMeta === "object"
      ? (billingMeta as Record<string, unknown>)
      : {}),
  });
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
    ON CONFLICT(job_id) DO NOTHING
  `);

  await stmt
    .bind(jobId, deviceId, model, JSON.stringify(payload ?? {}), relayJobId ?? null)
    .run();
};

export const createTranslationJobWithReservation = async ({
  jobId,
  deviceId,
  model,
  payload,
  reservationRequestKey,
  reservationSpend,
  reservationReason,
  reservationMeta,
}: {
  jobId: string;
  deviceId: string;
  model: string;
  payload: Record<string, unknown>;
  reservationRequestKey: string;
  reservationSpend: number;
  reservationReason: string;
  reservationMeta?: unknown;
}): Promise<
  | { ok: true; status: "created" }
  | { ok: true; status: "duplicate"; job: TranslationJobRecord }
  | { ok: false; error: "insufficient-credits" }
> => {
  if (!Number.isFinite(reservationSpend) || reservationSpend < 0) {
    throw new Error(`Invalid translation reservation spend: ${reservationSpend}`);
  }

  const db = getDatabase();
  const payloadJson = JSON.stringify(payload ?? {});
  const reservationMetaJson = JSON.stringify(reservationMeta ?? null);

  if (hasAtomicBatch(db)) {
    try {
      const statements = [
        db
          .prepare(
            `INSERT INTO translation_jobs (
               job_id,
               device_id,
               status,
               model,
               payload,
               relay_job_id,
               created_at,
               updated_at
             )
             VALUES (?, ?, 'queued', ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(job_id) DO NOTHING`
          )
          .bind(jobId, deviceId, model, payloadJson),
        buildRollbackIfNoChangesStatement(`create-translation-job:${jobId}`),
      ];

      if (reservationSpend > 0) {
        statements.push(
          db
            .prepare(
              `UPDATE credits
                  SET credit_balance = credit_balance - ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?
                  AND credit_balance >= ?`
            )
            .bind(reservationSpend, deviceId, reservationSpend),
          buildRollbackIfNoChangesStatement(
            `reserve-translation-job:${jobId}`
          )
        );
      }

      statements.push(
        db
          .prepare(
            `INSERT INTO billing_reservations (
               device_id,
               service,
               request_key,
               reserved_spend,
               settled_spend,
               status,
               meta,
               created_at,
               updated_at
             )
             VALUES (?, 'translation', ?, ?, NULL, 'reserved', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
          )
          .bind(
            deviceId,
            reservationRequestKey,
            reservationSpend,
            reservationMetaJson
          )
      );

      if (reservationSpend > 0) {
        statements.push(
          db
            .prepare(
              `INSERT INTO credit_ledger (device_id, delta, reason, meta)
               VALUES (?, ?, ?, ?)`
            )
            .bind(
              deviceId,
              -reservationSpend,
              reservationReason,
              reservationMetaJson
            )
        );
      }

      await executeAtomicBatch(statements);
      return { ok: true, status: "created" } as const;
    } catch (error: unknown) {
      if (isRollbackIfNoChangesError(error)) {
        const existingJob = await getTranslationJob({ jobId });
        if (existingJob) {
          return { ok: true, status: "duplicate", job: existingJob } as const;
        }
        return { ok: false, error: "insufficient-credits" } as const;
      }
      throw error;
    }
  }

  return runInTransaction(async () => {
    const existingJob = await getTranslationJob({ jobId });
    if (existingJob) {
      return { ok: true, status: "duplicate", job: existingJob } as const;
    }

    await db
      .prepare(
        `INSERT INTO translation_jobs (
           job_id,
           device_id,
           status,
           model,
           payload,
           relay_job_id,
           created_at,
           updated_at
         )
         VALUES (?, ?, 'queued', ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .bind(jobId, deviceId, model, payloadJson)
      .run();

    if (reservationSpend > 0) {
      const creditUpdate = await db
        .prepare(
          `UPDATE credits
              SET credit_balance = credit_balance - ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?
              AND credit_balance >= ?`
        )
        .bind(reservationSpend, deviceId, reservationSpend)
        .run();
      if ((creditUpdate.meta?.changes ?? 0) <= 0) {
        throw new Error("insufficient-credits");
      }
    }

    await db
      .prepare(
        `INSERT INTO billing_reservations (
           device_id,
           service,
           request_key,
           reserved_spend,
           settled_spend,
           status,
           meta,
           created_at,
           updated_at
         )
         VALUES (?, 'translation', ?, ?, NULL, 'reserved', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .bind(deviceId, reservationRequestKey, reservationSpend, reservationMetaJson)
      .run();

    if (reservationSpend > 0) {
      await db
        .prepare(
          `INSERT INTO credit_ledger (device_id, delta, reason, meta)
           VALUES (?, ?, ?, ?)`
        )
        .bind(deviceId, -reservationSpend, reservationReason, reservationMetaJson)
        .run();
    }

    return { ok: true, status: "created" } as const;
  }).catch(async (error: unknown) => {
    if (String((error as any)?.message || error) === "insufficient-credits") {
      return { ok: false, error: "insufficient-credits" } as const;
    }
    const existingJob = await getTranslationJob({ jobId });
    if (existingJob) {
      return { ok: true, status: "duplicate", job: existingJob } as const;
    }
    throw error;
  });
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
        AND credited = 0
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
       AND credited = 0
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
       AND credited = 0
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
       AND credited = 0
  `);

  await stmt.bind(relayJobId, jobId).run();
};

export const countTranslationJobsInFlight = async (): Promise<number> => {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT COUNT(1) AS count
      FROM translation_jobs
     WHERE status IN ('processing', 'dispatching')
       AND credited = 0
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
       AND credited = 0
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
       AND credited = 0
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
       AND credited = 0
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
       AND credited = 0
       AND (
         SELECT COUNT(1)
           FROM translation_jobs
          WHERE status IN ('processing', 'dispatching')
            AND credited = 0
       ) < ?
  `)
    : db.prepare(`
    UPDATE translation_jobs
       SET status = 'dispatching',
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
       AND status = 'queued'
       AND relay_job_id IS NULL
       AND credited = 0
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

export const completeTranslationJobWithSettlement = async ({
  jobId,
  deviceId,
  requestKey,
  result,
  promptTokens,
  completionTokens,
  actualSpend,
  reason,
  billingMeta,
}: {
  jobId: string;
  deviceId: string;
  requestKey: string;
  result: unknown;
  promptTokens?: number | null;
  completionTokens?: number | null;
  actualSpend: number;
  reason: string;
  billingMeta?: unknown;
}): Promise<
  | { ok: true; status: "completed" | "duplicate" }
  | {
      ok: false;
      error: "job-not-found" | "missing-reservation" | "actual-spend-exceeds-reserve";
    }
> => {
  const db = getDatabase();
  const resultJson = JSON.stringify(result ?? {});
  const billingMetaJson = JSON.stringify(billingMeta ?? null);
  const updateCompletedJob = async (): Promise<void> => {
    await db
      .prepare(
        `UPDATE translation_jobs
            SET status = 'completed',
                result = ?,
                error = NULL,
                prompt_tokens = ?,
                completion_tokens = ?,
                credited = 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE job_id = ?`
      )
      .bind(
        resultJson,
        promptTokens ?? null,
        completionTokens ?? null,
        jobId
      )
      .run();
  };

  if (hasAtomicBatch(db)) {
    const job = (await db
      .prepare(
        `SELECT credited
           FROM translation_jobs
          WHERE job_id = ?
          LIMIT 1`
      )
      .bind(jobId)
      .first()) as TranslationJobSettlementState | null;

    if (!job) {
      return { ok: false, error: "job-not-found" } as const;
    }

    const credited =
      typeof job.credited === "number"
        ? job.credited
        : Number.parseInt(String(job.credited ?? 0), 10) || 0;

    if (credited > 0) {
      await updateCompletedJob();
      return { ok: true, status: "duplicate" } as const;
    }

    const reservation = (await db
      .prepare(
        `SELECT reserved_spend, status
           FROM billing_reservations
          WHERE device_id = ?
            AND service = 'translation'
            AND request_key = ?
          LIMIT 1`
      )
      .bind(deviceId, requestKey)
      .first()) as BillingReservationState | null;

    if (!reservation) {
      return { ok: false, error: "missing-reservation" } as const;
    }

    const reservedSpend =
      typeof reservation.reserved_spend === "number"
        ? reservation.reserved_spend
        : Number.parseInt(String(reservation.reserved_spend ?? 0), 10) || 0;

    if (reservation.status === "settled") {
      await updateCompletedJob();
      return { ok: true, status: "duplicate" } as const;
    }

    if (reservation.status !== "reserved") {
      return { ok: false, error: "missing-reservation" } as const;
    }

    if (actualSpend > reservedSpend) {
      const releaseMetaJson = JSON.stringify({
        releaseReason: "actual-spend-exceeds-reserve",
        reservedSpend,
        actualSpend,
        ...(billingMeta && typeof billingMeta === "object"
          ? (billingMeta as Record<string, unknown>)
          : {}),
      });

      try {
        const statements = [
          db
            .prepare(
              `UPDATE billing_reservations
                  SET status = 'released',
                      settled_spend = NULL,
                      meta = ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?
                  AND service = 'translation'
                  AND request_key = ?
                  AND status = 'reserved'
                  AND reserved_spend = ?`
            )
            .bind(releaseMetaJson, deviceId, requestKey, reservedSpend),
          buildRollbackIfNoChangesStatement(
            `translation-job-release:${requestKey}`
          ),
        ];

        if (reservedSpend > 0) {
          statements.push(
            db
              .prepare(
                `UPDATE credits
                    SET credit_balance = credit_balance + ?,
                        updated_at = CURRENT_TIMESTAMP
                  WHERE device_id = ?`
              )
              .bind(reservedSpend, deviceId),
            db
              .prepare(
                `INSERT INTO credit_ledger (device_id, delta, reason, meta)
                 VALUES (?, ?, ?, ?)`
              )
              .bind(deviceId, reservedSpend, `${reason}_REFUND`, billingMetaJson)
          );
        }

        await executeAtomicBatch(statements);
        return { ok: false, error: "actual-spend-exceeds-reserve" } as const;
      } catch (error: unknown) {
        if (isRollbackIfNoChangesError(error)) {
          const currentReservation = (await db
            .prepare(
              `SELECT reserved_spend, status
                 FROM billing_reservations
                WHERE device_id = ?
                  AND service = 'translation'
                  AND request_key = ?
                LIMIT 1`
            )
            .bind(deviceId, requestKey)
            .first()) as BillingReservationState | null;
          if (currentReservation?.status === "settled") {
            await updateCompletedJob();
            return { ok: true, status: "duplicate" } as const;
          }
          if (!currentReservation || currentReservation.status === "released") {
            return { ok: false, error: "actual-spend-exceeds-reserve" } as const;
          }
          return { ok: false, error: "missing-reservation" } as const;
        }
        throw error;
      }
    }

    const refund = reservedSpend - actualSpend;

    try {
      const statements = [
        db
          .prepare(
            `UPDATE translation_jobs
                SET status = 'completed',
                    result = ?,
                    error = NULL,
                    prompt_tokens = ?,
                    completion_tokens = ?,
                    credited = 1,
                    updated_at = CURRENT_TIMESTAMP
              WHERE job_id = ?
                AND credited = 0`
          )
          .bind(
            resultJson,
            promptTokens ?? null,
            completionTokens ?? null,
            jobId
          ),
        db
          .prepare(
            `UPDATE billing_reservations
                SET status = 'settled',
                    settled_spend = ?,
                    meta = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE device_id = ?
                AND service = 'translation'
                AND request_key = ?
                AND status = 'reserved'
                AND reserved_spend = ?`
          )
          .bind(actualSpend, billingMetaJson, deviceId, requestKey, reservedSpend),
        buildRollbackIfNoChangesStatement(
          `translation-job-settle:${requestKey}`
        ),
      ];

      if (refund > 0) {
        statements.push(
          db
            .prepare(
              `UPDATE credits
                  SET credit_balance = credit_balance + ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?`
            )
            .bind(refund, deviceId),
          db
            .prepare(
              `INSERT INTO credit_ledger (device_id, delta, reason, meta)
               VALUES (?, ?, ?, ?)`
            )
            .bind(deviceId, refund, `${reason}_REFUND`, billingMetaJson)
        );
      }

      await executeAtomicBatch(statements);
      return { ok: true, status: "completed" } as const;
    } catch (error: unknown) {
      if (isRollbackIfNoChangesError(error)) {
        const currentReservation = (await db
          .prepare(
            `SELECT reserved_spend, status
               FROM billing_reservations
              WHERE device_id = ?
                AND service = 'translation'
                AND request_key = ?
              LIMIT 1`
          )
          .bind(deviceId, requestKey)
          .first()) as BillingReservationState | null;
        if (currentReservation?.status === "settled") {
          await updateCompletedJob();
          return { ok: true, status: "duplicate" } as const;
        }
        if (!currentReservation || currentReservation.status !== "reserved") {
          return { ok: false, error: "missing-reservation" } as const;
        }
      }
      throw error;
    }
  }

  return runInTransaction(async () => {
    const job = (await db
      .prepare(
        `SELECT credited
           FROM translation_jobs
          WHERE job_id = ?
          LIMIT 1`
      )
      .bind(jobId)
      .first()) as TranslationJobSettlementState | null;

    if (!job) {
      return { ok: false, error: "job-not-found" } as const;
    }

    const credited =
      typeof job.credited === "number"
        ? job.credited
        : Number.parseInt(String(job.credited ?? 0), 10) || 0;

    if (credited > 0) {
      await db
        .prepare(
          `UPDATE translation_jobs
              SET status = 'completed',
                  result = ?,
                  error = NULL,
                  prompt_tokens = ?,
                  completion_tokens = ?,
                  credited = 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE job_id = ?`
        )
        .bind(
          resultJson,
          promptTokens ?? null,
          completionTokens ?? null,
          jobId
        )
        .run();
      return { ok: true, status: "duplicate" } as const;
    }

    const reservation = (await db
      .prepare(
        `SELECT reserved_spend, status
           FROM billing_reservations
          WHERE device_id = ?
            AND service = 'translation'
            AND request_key = ?
          LIMIT 1`
      )
      .bind(deviceId, requestKey)
      .first()) as BillingReservationState | null;

    if (!reservation) {
      return { ok: false, error: "missing-reservation" } as const;
    }

    const reservedSpend =
      typeof reservation.reserved_spend === "number"
        ? reservation.reserved_spend
        : Number.parseInt(String(reservation.reserved_spend ?? 0), 10) || 0;

    if (reservation.status === "settled") {
      await db
        .prepare(
          `UPDATE translation_jobs
              SET status = 'completed',
                  result = ?,
                  error = NULL,
                  prompt_tokens = ?,
                  completion_tokens = ?,
                  credited = 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE job_id = ?`
        )
        .bind(
          resultJson,
          promptTokens ?? null,
          completionTokens ?? null,
          jobId
        )
        .run();
      return { ok: true, status: "duplicate" } as const;
    }

    if (reservation.status !== "reserved") {
      return { ok: false, error: "missing-reservation" } as const;
    }

    if (actualSpend > reservedSpend) {
      const refund = reservedSpend;
      await db
        .prepare(
          `UPDATE billing_reservations
              SET status = 'released',
                  settled_spend = NULL,
                  meta = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?
              AND service = 'translation'
              AND request_key = ?
              AND status = 'reserved'`
        )
        .bind(
          JSON.stringify({
            releaseReason: "actual-spend-exceeds-reserve",
            reservedSpend,
            actualSpend,
            ...(billingMeta && typeof billingMeta === "object"
              ? (billingMeta as Record<string, unknown>)
              : {}),
          }),
          deviceId,
          requestKey
        )
        .run();

      if (refund > 0) {
        await db
          .prepare(
            `UPDATE credits
                SET credit_balance = credit_balance + ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE device_id = ?`
          )
          .bind(refund, deviceId)
          .run();

        await db
          .prepare(
            `INSERT INTO credit_ledger (device_id, delta, reason, meta)
             VALUES (?, ?, ?, ?)`
          )
          .bind(deviceId, refund, `${reason}_REFUND`, billingMetaJson)
          .run();
      }

      return { ok: false, error: "actual-spend-exceeds-reserve" } as const;
    }

    await db
      .prepare(
        `UPDATE translation_jobs
            SET status = 'completed',
                result = ?,
                error = NULL,
                prompt_tokens = ?,
                completion_tokens = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE job_id = ?`
      )
      .bind(
        resultJson,
        promptTokens ?? null,
        completionTokens ?? null,
        jobId
      )
      .run();

    const refund = reservedSpend - actualSpend;
    await db
      .prepare(
        `UPDATE billing_reservations
            SET status = 'settled',
                settled_spend = ?,
                meta = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ?
            AND service = 'translation'
            AND request_key = ?
            AND status = 'reserved'`
      )
      .bind(actualSpend, billingMetaJson, deviceId, requestKey)
      .run();

    if (refund > 0) {
      await db
        .prepare(
          `UPDATE credits
              SET credit_balance = credit_balance + ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?`
        )
        .bind(refund, deviceId)
        .run();

      await db
        .prepare(
          `INSERT INTO credit_ledger (device_id, delta, reason, meta)
           VALUES (?, ?, ?, ?)`
        )
        .bind(deviceId, refund, `${reason}_REFUND`, billingMetaJson)
        .run();
    }

    await db
      .prepare(
        `UPDATE translation_jobs
            SET credited = 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE job_id = ?`
      )
      .bind(jobId)
      .run();

    return { ok: true, status: "completed" } as const;
  });
};

export const failTranslationJobWithReservationRelease = async ({
  jobId,
  deviceId,
  requestKey,
  message,
  reason,
  billingMeta,
}: {
  jobId: string;
  deviceId: string;
  requestKey: string;
  message: string;
  reason: string;
  billingMeta?: unknown;
}): Promise<
  | { ok: true; status: "failed" }
  | { ok: false; error: "job-not-found" }
> => {
  const db = getDatabase();

  const updateFailedJob = async (): Promise<boolean> => {
    const res = await db
      .prepare(
        `UPDATE translation_jobs
            SET status = 'failed',
                error = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE job_id = ?`
      )
      .bind(message, jobId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  };

  const job = (await db
    .prepare(
      `SELECT job_id
         FROM translation_jobs
        WHERE job_id = ?
        LIMIT 1`
    )
    .bind(jobId)
    .first()) as { job_id: string } | null;
  if (!job) {
    return { ok: false, error: "job-not-found" } as const;
  }

  const reservation = (await db
    .prepare(
      `SELECT reserved_spend, settled_spend, status, meta
         FROM billing_reservations
        WHERE device_id = ?
          AND service = 'translation'
          AND request_key = ?
        LIMIT 1`
    )
    .bind(deviceId, requestKey)
    .first()) as BillingReservationState | null;

  if (!reservation || reservation.status === "released") {
    await updateFailedJob();
    return { ok: true, status: "failed" } as const;
  }

  const reservedSpend =
    typeof reservation.reserved_spend === "number"
      ? reservation.reserved_spend
      : Number.parseInt(String(reservation.reserved_spend ?? 0), 10) || 0;
  const settledSpend =
    typeof reservation.settled_spend === "number"
      ? reservation.settled_spend
      : reservation.settled_spend == null
        ? null
        : Number.parseInt(String(reservation.settled_spend), 10) || 0;
  const refund =
    reservation.status === "settled"
      ? Math.max(0, settledSpend ?? reservedSpend)
      : Math.max(0, reservedSpend);
  const billingMetaJson = buildTranslationFailureReleaseMeta({
    existingMetaRaw: reservation.meta,
    failureMessage: message,
    billingMeta,
  });

  if (hasAtomicBatch(db)) {
    try {
      const statements = [
        db
          .prepare(
            `UPDATE translation_jobs
                SET status = 'failed',
                    error = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE job_id = ?`
          )
          .bind(message, jobId),
        db
          .prepare(
            `UPDATE billing_reservations
                SET status = 'released',
                    settled_spend = NULL,
                    meta = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE device_id = ?
                AND service = 'translation'
                AND request_key = ?
                AND status = ?`
          )
          .bind(billingMetaJson, deviceId, requestKey, reservation.status),
        buildRollbackIfNoChangesStatement(
          `translation-job-release-on-failure:${requestKey}`
        ),
      ];

      if (refund > 0) {
        statements.push(
          db
            .prepare(
              `UPDATE credits
                  SET credit_balance = credit_balance + ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?`
            )
            .bind(refund, deviceId),
          db
            .prepare(
              `INSERT INTO credit_ledger (device_id, delta, reason, meta)
               VALUES (?, ?, ?, ?)`
            )
            .bind(deviceId, refund, `${reason}_REFUND`, billingMetaJson)
        );
      }

      await executeAtomicBatch(statements);
      return { ok: true, status: "failed" } as const;
    } catch (error: unknown) {
      if (isRollbackIfNoChangesError(error)) {
        await updateFailedJob();
        return { ok: true, status: "failed" } as const;
      }
      throw error;
    }
  }

  return runInTransaction(async () => {
    const currentReservation = (await db
      .prepare(
        `SELECT reserved_spend, settled_spend, status, meta
           FROM billing_reservations
          WHERE device_id = ?
            AND service = 'translation'
            AND request_key = ?
          LIMIT 1`
      )
      .bind(deviceId, requestKey)
      .first()) as BillingReservationState | null;

    if (!currentReservation || currentReservation.status === "released") {
      await updateFailedJob();
      return { ok: true, status: "failed" } as const;
    }

    const currentReservedSpend =
      typeof currentReservation.reserved_spend === "number"
        ? currentReservation.reserved_spend
        : Number.parseInt(String(currentReservation.reserved_spend ?? 0), 10) || 0;
    const currentSettledSpend =
      typeof currentReservation.settled_spend === "number"
        ? currentReservation.settled_spend
        : currentReservation.settled_spend == null
          ? null
          : Number.parseInt(String(currentReservation.settled_spend), 10) || 0;
    const currentRefund =
      currentReservation.status === "settled"
        ? Math.max(0, currentSettledSpend ?? currentReservedSpend)
        : Math.max(0, currentReservedSpend);
    const currentMetaJson = buildTranslationFailureReleaseMeta({
      existingMetaRaw: currentReservation.meta,
      failureMessage: message,
      billingMeta,
    });

    await updateFailedJob();

    await db
      .prepare(
        `UPDATE billing_reservations
            SET status = 'released',
                settled_spend = NULL,
                meta = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ?
            AND service = 'translation'
            AND request_key = ?
            AND status = ?`
      )
      .bind(currentMetaJson, deviceId, requestKey, currentReservation.status)
      .run();

    if (currentRefund > 0) {
      await db
        .prepare(
          `UPDATE credits
              SET credit_balance = credit_balance + ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?`
        )
        .bind(currentRefund, deviceId)
        .run();

      await db
        .prepare(
          `INSERT INTO credit_ledger (device_id, delta, reason, meta)
           VALUES (?, ?, ?, ?)`
        )
        .bind(deviceId, currentRefund, `${reason}_REFUND`, currentMetaJson)
        .run();
    }

    return { ok: true, status: "failed" } as const;
  });
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
