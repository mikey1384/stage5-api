import { type PackId, packs } from "../types/packs";
import { tokensToCredits, secondsToCredits } from "./pricing";

// Types for database operations
export interface CreditRecord {
  device_id: string;
  credit_balance: number;
  updated_at: string;
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
    db = env.DB; // ① bind the Worker's D1 instance
  }
  if (!tablesCreated) {
    // ② run migrations exactly once - single-line to avoid D1 newline issues
    await db.exec(
      "CREATE TABLE IF NOT EXISTS credits(device_id TEXT PRIMARY KEY, credit_balance INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    );

    await db.exec(
      "CREATE TABLE IF NOT EXISTS processed_events(event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, processed_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    );

    // Add credit ledger table
    await db.exec(
      "CREATE TABLE IF NOT EXISTS credit_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, meta TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    );

    tablesCreated = true;
  }
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
}: {
  deviceId: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<boolean> => {
  const spend = tokensToCredits({
    prompt: promptTokens,
    completion: completionTokens,
  });
  return updateBalance(deviceId, spend, {
    reason: "TRANSLATE",
    meta: { promptTokens, completionTokens },
  });
};

export const deductTranscriptionCredits = async ({
  deviceId,
  seconds,
}: {
  deviceId: string;
  seconds: number;
}): Promise<boolean> => {
  const spend = secondsToCredits({ seconds });
  return updateBalance(deviceId, spend, {
    reason: "TRANSCRIBE",
    meta: { seconds },
  });
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
