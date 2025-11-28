import { type PackId, packs } from "../types/packs";
import { tokensToCredits, secondsToCredits } from "./pricing";

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

// Helper function for updating balance
const updateBalance = async (
  deviceId: string,
  spend: number,
  { reason, meta }: { reason: string; meta?: unknown }
): Promise<boolean> => {
  if (!db) throw new Error("Database not initialized");

  if (spend <= 0) {
    console.log(`No credits to deduct for device ${deviceId}. Usage was zero.`);
    return true;
  }

  try {
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
}: {
  deviceId: string;
  seconds: number;
  model: string;
}): Promise<boolean> => {
  const spend = secondsToCredits({ seconds, model });
  return updateBalance(deviceId, spend, {
    reason: "TRANSCRIBE",
    meta: { seconds, model },
  });
};

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
