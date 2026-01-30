import { type PackId, packs } from "../types/packs";
import { tokensToCredits, secondsToCredits, charactersToCredits, estimateVoiceCloningCredits, type TTSModel } from "./pricing";

// Types for database operations
export interface CreditRecord {
  device_id: string;
  credit_balance: number;
  updated_at: string;
}

export interface EntitlementRecord {
  device_id: string;
  byo_openai: number;
  byo_anthropic: number;
  unlocked_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// For Cloudflare Workers with D1
declare global {
  interface CloudflareBindings {
    DB: D1Database;
  }
}

// Database interface - works with both D1 and regular SQLite
interface Database {
  prepare(query: string): any;
  exec(query: string): Promise<any>;
  // D1 supports batch() which executes statements in a single transaction.
  batch?: (statements: any[]) => Promise<any>;
}

// Initialize database (D1 in Workers, SQLite elsewhere)
let db: Database | undefined;
let tablesCreated = false;

export const ensureDatabase = async (env: { DB: D1Database }) => {
  if (!db) {
    db = env.DB; // Bind the Worker's D1 instance
  }
  // Tables already exist in production - use `wrangler d1 migrations` for schema changes
  tablesCreated = true;
};

// Check if webhook event has been processed (idempotency)
export const isEventProcessed = async ({
  eventId,
}: {
  eventId: string;
}): Promise<boolean> => {
  if (!db) throw new Error("Database not initialized");

  try {
    const stmt = db.prepare(
      "SELECT event_id FROM processed_events WHERE event_id = ?"
    );
    const result = await stmt.bind(eventId).first();
    return !!result;
  } catch (error) {
    console.error("Error checking event processing:", error);
    throw error;
  }
};

// Mark webhook event as processed
export const markEventProcessed = async ({
  eventId,
  eventType,
}: {
  eventId: string;
  eventType: string;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

  try {
    const stmt = db.prepare(`
      INSERT INTO processed_events (event_id, event_type, processed_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id) DO NOTHING
    `);

    await stmt.bind(eventId, eventType).run();
  } catch (error) {
    console.error("Error marking event as processed:", error);
    throw error;
  }
};

// Get credits for a device
export const getCredits = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<CreditRecord | null> => {
  if (!db) throw new Error("Database not initialized");

  try {
    const stmt = db.prepare("SELECT * FROM credits WHERE device_id = ?");
    const result = await stmt.bind(deviceId).first();
    return result as CreditRecord | null;
  } catch (error) {
    console.error("Error getting credits:", error);
    throw error;
  }
};

// Add credits to a device (upsert)
export const creditDevice = async ({
  deviceId,
  packId,
  isAdminReset = false,
}: {
  deviceId: string;
  packId: PackId;
  isAdminReset?: boolean;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

  // Get credits amount from pack definition
  const pack = packs[packId];
  if (!pack) {
    throw new Error(`Invalid pack ID for credit system: ${packId}`);
  }

  const creditsToAdd = pack.credits;

  try {
    const stmt = db.prepare(`
      INSERT INTO credits (device_id, credit_balance, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        credit_balance = credit_balance + ?,
        updated_at = CURRENT_TIMESTAMP
    `);

    await stmt.bind(deviceId, creditsToAdd, creditsToAdd).run();

    // Record ledger entry for pack top-up or admin reset
    await recordLedger({
      deviceId,
      delta: +creditsToAdd,
      reason: isAdminReset ? "ADMIN_RESET" : `PACK_${packId.toUpperCase()}`,
      meta: isAdminReset ? { pack: packId } : undefined,
    });

    console.log(
      `Added ${creditsToAdd} credits (${packId}) to device ${deviceId}`
    );
  } catch (error) {
    console.error("Error crediting device:", error);
    throw error;
  }
};

// Reset credits to zero for a device (admin only)
export const resetCreditsToZero = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

  try {
    // Get current balance first for ledger
    const currentRecord = await getCredits({ deviceId });
    const currentBalance = currentRecord?.credit_balance || 0;

    // Set credits to 0
    const stmt = db.prepare(`
      INSERT INTO credits (device_id, credit_balance, updated_at)
      VALUES (?, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        credit_balance = 0,
        updated_at = CURRENT_TIMESTAMP
    `);

    await stmt.bind(deviceId).run();

    // Record ledger entry for admin reset to zero
    if (currentBalance > 0) {
      await recordLedger({
        deviceId,
        delta: -currentBalance,
        reason: "ADMIN_RESET_TO_ZERO",
        meta: { previousBalance: currentBalance },
      });
    }

    console.log(
      `Reset credits to 0 for device ${deviceId} (was ${currentBalance})`
    );
  } catch (error) {
    console.error("Error resetting credits to zero:", error);
    throw error;
  }
};

// Get user by API key (which is the device_id)
export const getUserByApiKey = async ({
  apiKey,
}: {
  apiKey: string;
}): Promise<CreditRecord | null> => {
  return getCredits({ deviceId: apiKey });
};

/**
 * Atomically deduct credits from a device's balance.
 *
 * This uses SQL's atomic UPDATE with WHERE clause to prevent race conditions:
 * - The balance check (credit_balance >= spend) and deduction happen in a single statement
 * - If two concurrent requests try to spend credits, only one will succeed
 * - We verify success by checking rows affected (res.meta.changes)
 */
const updateBalance = async (
  deviceId: string,
  spend: number,
  { reason, meta }: { reason: string; meta?: unknown }
): Promise<boolean> => {
  if (!db) throw new Error("Database not initialized");

  if (!Number.isFinite(spend) || spend <= 0) {
    console.log(`No credits to deduct for device ${deviceId}. Usage was zero or invalid.`);
    return true;
  }

  try {
    // Atomic check-and-deduct: WHERE clause ensures we only deduct if balance is sufficient
    const stmt = db.prepare(
      `UPDATE credits
         SET credit_balance = credit_balance - ?,
             updated_at      = CURRENT_TIMESTAMP
       WHERE device_id = ? AND credit_balance >= ?`
    );

    const res = await stmt.bind(spend, deviceId, spend).run();

    if ((res.meta?.changes ?? 0) > 0) {
      console.log(`Deducted ${spend} credits from device ${deviceId}.`);

      // Record ledger entry for deduction
      await recordLedger({
        deviceId,
        delta: -spend,
        reason,
        meta, // pass in tokens / seconds etc.
      });

      return true;
    } else {
      console.warn(
        `Failed to deduct ${spend} credits for device ${deviceId}. Insufficient balance.`
      );
      return false;
    }
  } catch (error) {
    console.error("Error deducting credits:", error);
    throw error;
  }
};

function isBillingIdempotencyUniqueConstraintError(error: any): boolean {
  const msg = String(error?.message || error || "");
  return (
    msg.includes("UNIQUE constraint failed") && msg.includes("billing_idempotency")
  );
}

function isBillingIdempotencyNotNullRollbackError(error: any): boolean {
  const msg = String(error?.message || error || "");
  return msg.includes("NOT NULL constraint failed: billing_idempotency.reason");
}

/**
 * Idempotent variant of updateBalance.
 *
 * We record an idempotency key in `billing_idempotency` inside the same transaction
 * as the credit balance update + ledger insertion. This makes retries safe under
 * real network conditions (e.g. client disconnects after the server already charged).
 */
const updateBalanceIdempotent = async (
  deviceId: string,
  spend: number,
  {
    reason,
    meta,
    idempotencyKey,
  }: { reason: string; meta?: unknown; idempotencyKey: string }
): Promise<boolean> => {
  if (!db) throw new Error("Database not initialized");

  if (!Number.isFinite(spend) || spend <= 0) {
    console.log(
      `No credits to deduct for device ${deviceId}. Usage was zero or invalid.`
    );
    return true;
  }

  const metaWithIdempotency = { ...(meta as any), idempotencyKey };
  const metaJson = JSON.stringify(metaWithIdempotency ?? null);

  // Prefer D1 batch() for atomicity.
  if (typeof db.batch === "function") {
    try {
      const statements = [
        db
          .prepare(
            `INSERT INTO billing_idempotency (device_id, reason, idempotency_key, spend, meta, created_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
          )
          .bind(deviceId, reason, idempotencyKey, spend, metaJson),
        db
          .prepare(
            `UPDATE credits
               SET credit_balance = credit_balance - ?,
                   updated_at      = CURRENT_TIMESTAMP
             WHERE device_id = ? AND credit_balance >= ?`
          )
          .bind(spend, deviceId, spend),
        // If the credit update didn't affect a row, force a rollback by violating NOT NULL.
        // This keeps idempotency + ledger consistent with the balance update.
        db
          .prepare(
            `INSERT INTO billing_idempotency (device_id, reason, idempotency_key, spend, meta, created_at)
             SELECT ?, NULL, ?, ?, ?, CURRENT_TIMESTAMP
              WHERE (SELECT changes()) = 0`
          )
          .bind(deviceId, idempotencyKey, spend, metaJson),
        db
          .prepare(
            `INSERT INTO credit_ledger (device_id, delta, reason, meta)
             VALUES (?, ?, ?, ?)`
          )
          .bind(deviceId, -spend, reason, metaJson),
      ];

      await db.batch(statements);
      console.log(
        `Deducted ${spend} credits from device ${deviceId} (idempotencyKey=${idempotencyKey}).`
      );
      return true;
    } catch (error) {
      // Already processed (duplicate retry) -> treat as success.
      if (isBillingIdempotencyUniqueConstraintError(error)) {
        console.log(
          `Skipping duplicate charge for device ${deviceId} (idempotencyKey=${idempotencyKey}).`
        );
        return true;
      }

      // Insufficient balance (or missing device row) -> treat as failure.
      if (isBillingIdempotencyNotNullRollbackError(error)) {
        console.warn(
          `Failed to deduct ${spend} credits for device ${deviceId}. Insufficient balance.`
        );
        return false;
      }

      console.error("Error deducting credits (idempotent):", error);
      throw error;
    }
  }

  // Fallback for non-D1 environments:
  // Use an explicit SQL transaction so we never "lock out" retries by writing the
  // idempotency marker without also committing the credit deduction + ledger.
  try {
    await db.exec("BEGIN");

    await db
      .prepare(
        `INSERT INTO billing_idempotency (device_id, reason, idempotency_key, spend, meta, created_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .bind(deviceId, reason, idempotencyKey, spend, metaJson)
      .run();

    const updateRes = await db
      .prepare(
        `UPDATE credits
           SET credit_balance = credit_balance - ?,
               updated_at      = CURRENT_TIMESTAMP
         WHERE device_id = ? AND credit_balance >= ?`
      )
      .bind(spend, deviceId, spend)
      .run();

    const changes =
      typeof (updateRes as any)?.meta?.changes === "number"
        ? (updateRes as any).meta.changes
        : typeof (updateRes as any)?.changes === "number"
          ? (updateRes as any).changes
          : 0;

    if (changes <= 0) {
      await db.exec("ROLLBACK");
      console.warn(
        `Failed to deduct ${spend} credits for device ${deviceId}. Insufficient balance.`
      );
      return false;
    }

    await db
      .prepare(
        `INSERT INTO credit_ledger (device_id, delta, reason, meta)
         VALUES (?, ?, ?, ?)`
      )
      .bind(deviceId, -spend, reason, metaJson)
      .run();

    await db.exec("COMMIT");
    console.log(
      `Deducted ${spend} credits from device ${deviceId} (idempotencyKey=${idempotencyKey}).`
    );
    return true;
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors (e.g., transaction never began)
    }

    // Already processed (duplicate retry) -> treat as success.
    if (isBillingIdempotencyUniqueConstraintError(error)) {
      console.log(
        `Skipping duplicate charge for device ${deviceId} (idempotencyKey=${idempotencyKey}).`
      );
      return true;
    }

    console.error("Error deducting credits (idempotent):", error);
    throw error;
  }
};

// New deduction functions using the cost calculation helpers
export const deductTranslationCredits = async ({
  deviceId,
  promptTokens,
  completionTokens,
  model = "gpt-5.1",
}: {
  deviceId: string;
  promptTokens: number;
  completionTokens: number;
  model?: string;
}): Promise<boolean> => {
  const spend = tokensToCredits({
    prompt: promptTokens,
    completion: completionTokens,
    model,
  });
  return updateBalance(deviceId, spend, {
    reason: "TRANSLATE",
    meta: { promptTokens, completionTokens, model },
  });
};

export const deductTranscriptionCredits = async ({
  deviceId,
  seconds,
  model,
  idempotencyKey,
}: {
  deviceId: string;
  seconds: number;
  model: string;
  idempotencyKey?: string;
}): Promise<boolean> => {
  const spend = secondsToCredits({ seconds, model });
  const reason = "TRANSCRIBE";
  const meta = { seconds, model };
  if (idempotencyKey) {
    return updateBalanceIdempotent(deviceId, spend, {
      reason,
      meta,
      idempotencyKey,
    });
  }
  return updateBalance(deviceId, spend, { reason, meta });
};

/** @deprecated Use deductTTSCredits instead for accurate TTS pricing */
export const deductSpeechCredits = async ({
  deviceId,
  promptTokens,
  meta,
}: {
  deviceId: string;
  promptTokens: number;
  meta?: Record<string, unknown>;
}): Promise<boolean> => {
  const spend = tokensToCredits({ prompt: promptTokens, completion: 0 });
  return updateBalance(deviceId, spend, {
    reason: "DUB",
    meta: { promptTokens, ...(meta ?? {}) },
  });
};

/**
 * Deduct credits for TTS (dubbing) based on character count and model
 */
export const deductTTSCredits = async ({
  deviceId,
  characters,
  model,
  meta,
}: {
  deviceId: string;
  characters: number;
  model: TTSModel;
  meta?: Record<string, unknown>;
}): Promise<boolean> => {
  const spend = charactersToCredits({ characters, model });
  return updateBalance(deviceId, spend, {
    reason: "DUB",
    meta: { characters, model, ...(meta ?? {}) },
  });
};

/**
 * Deduct credits for voice cloning (ElevenLabs Dubbing API) based on duration
 */
export const deductVoiceCloningCredits = async ({
  deviceId,
  durationSeconds,
  meta,
}: {
  deviceId: string;
  durationSeconds: number;
  meta?: Record<string, unknown>;
}): Promise<boolean> => {
  const { credits: spend } = estimateVoiceCloningCredits({ durationSeconds });
  return updateBalance(deviceId, spend, {
    reason: "VOICE_CLONE",
    meta: { durationSeconds, ...(meta ?? {}) },
  });
};

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
  if (!db) throw new Error("Database not initialized");

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

export const getTranslationJob = async ({
  jobId,
}: {
  jobId: string;
}): Promise<TranslationJobRecord | null> => {
  if (!db) throw new Error("Database not initialized");

  const stmt = db.prepare(
    "SELECT * FROM translation_jobs WHERE job_id = ?"
  );
  const result = await stmt.bind(jobId).first();
  return (result as TranslationJobRecord) ?? null;
};

export const setTranslationJobProcessing = async ({
  jobId,
  relayJobId,
}: {
  jobId: string;
  relayJobId: string | null;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

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
  if (!db) throw new Error("Database not initialized");

  const stmt = db.prepare(`
    UPDATE translation_jobs
       SET status = 'queued',
           relay_job_id = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(jobId).run();
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
  if (!db) throw new Error("Database not initialized");

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
  if (!db) throw new Error("Database not initialized");

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
  if (!db) throw new Error("Database not initialized");

  const stmt = db.prepare(`
    UPDATE translation_jobs
       SET credited = 1,
           updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?
  `);

  await stmt.bind(jobId).run();
};

const recordLedger = async ({
  deviceId,
  delta,
  reason,
  meta,
}: {
  deviceId: string;
  delta: number;
  reason: string;
  meta?: unknown;
}): Promise<void> => {
  if (!db) throw new Error("DB not initialised");

  await db
    .prepare(
      `INSERT INTO credit_ledger (device_id, delta, reason, meta)
       VALUES (?, ?, ?, ?)`
    )
    .bind(deviceId, delta, reason, JSON.stringify(meta ?? null))
    .run();
};

// Get ledger entries for a device
export const getLedgerEntries = async ({
  deviceId,
  limit = 100,
}: {
  deviceId: string;
  limit?: number;
}): Promise<any[]> => {
  if (!db) throw new Error("Database not initialized");

  try {
    const stmt = db.prepare(
      `SELECT delta, reason, meta, created_at 
       FROM credit_ledger 
       WHERE device_id = ? 
       ORDER BY id DESC 
       LIMIT ?`
    );
    const result = await stmt.bind(deviceId, limit).all();
    return result.results || [];
  } catch (error) {
    console.error("Error getting ledger entries:", error);
    throw error;
  }
};

export const getEntitlementsRecord = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<EntitlementRecord | null> => {
  if (!db) throw new Error("Database not initialized");

  try {
    const stmt = db.prepare(
      `SELECT device_id, byo_openai, byo_anthropic, unlocked_at, created_at, updated_at
       FROM entitlements
       WHERE device_id = ?`
    );
    const row = await stmt.bind(deviceId).first();
    return (row as EntitlementRecord) ?? null;
  } catch (error) {
    console.error("Error loading entitlements:", error);
    throw error;
  }
};

export const grantByoOpenAiEntitlement = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

  try {
    // BYO unlock grants access to BOTH OpenAI and Anthropic keys (single $10 purchase)
    const stmt = db.prepare(`
      INSERT INTO entitlements (device_id, byo_openai, byo_anthropic, unlocked_at, created_at, updated_at)
      VALUES (?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        byo_openai = 1,
        byo_anthropic = 1,
        unlocked_at = CASE
          WHEN entitlements.unlocked_at IS NULL THEN CURRENT_TIMESTAMP
          ELSE entitlements.unlocked_at
        END,
        updated_at = CURRENT_TIMESTAMP
    `);

    await stmt.bind(deviceId).run();
  } catch (error) {
    console.error("Error granting BYO entitlement:", error);
    throw error;
  }
};

export const grantByoAnthropicEntitlement = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

  try {
    const stmt = db.prepare(`
      INSERT INTO entitlements (device_id, byo_anthropic, unlocked_at, created_at, updated_at)
      VALUES (?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        byo_anthropic = 1,
        unlocked_at = CASE
          WHEN entitlements.unlocked_at IS NULL THEN CURRENT_TIMESTAMP
          ELSE entitlements.unlocked_at
        END,
        updated_at = CURRENT_TIMESTAMP
    `);

    await stmt.bind(deviceId).run();
  } catch (error) {
    console.error("Error granting BYO Anthropic entitlement:", error);
    throw error;
  }
};

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
}: {
  jobId: string;
  deviceId: string;
  fileKey: string;
  language?: string;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

  const stmt = db.prepare(`
    INSERT INTO transcription_jobs (job_id, device_id, status, file_key, language, created_at, updated_at)
    VALUES (?, ?, 'pending_upload', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  await stmt.bind(jobId, deviceId, fileKey, language ?? null).run();
};

export const getTranscriptionJob = async ({
  jobId,
}: {
  jobId: string;
}): Promise<TranscriptionJobRecord | null> => {
  if (!db) throw new Error("Database not initialized");

  const stmt = db.prepare("SELECT * FROM transcription_jobs WHERE job_id = ?");
  const result = await stmt.bind(jobId).first();
  return (result as TranscriptionJobRecord) ?? null;
};

export const setTranscriptionJobProcessing = async ({
  jobId,
}: {
  jobId: string;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

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
  if (!db) throw new Error("Database not initialized");

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
  if (!db) throw new Error("Database not initialized");

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
  if (!db) throw new Error("Database not initialized");

  const stmt = db.prepare(`
    DELETE FROM transcription_jobs
     WHERE created_at < datetime('now', '-' || ? || ' hours')
  `);

  const res = await stmt.bind(maxAgeHours).run();
  return res.meta?.changes ?? 0;
};
