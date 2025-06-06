import { type PackId } from "../types/packs";

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

const CREDIT_PACK_AMOUNT = 250000;

// Add credits to a device (upsert)
export const creditDevice = async ({
  deviceId,
  packId,
}: {
  deviceId: string;
  packId: PackId;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

  if (packId !== "HOUR_5") {
    throw new Error(`Invalid pack ID for credit system: ${packId}`);
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO credits (device_id, credit_balance, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        credit_balance = credit_balance + ?,
        updated_at = CURRENT_TIMESTAMP
    `);

    await stmt.bind(deviceId, CREDIT_PACK_AMOUNT, CREDIT_PACK_AMOUNT).run();
    console.log(`Added ${CREDIT_PACK_AMOUNT} credits to device ${deviceId}`);
  } catch (error) {
    console.error("Error crediting device:", error);
    throw error;
  }
};

const TRANSCRIPTION_COST_PER_MINUTE = 600;
const TRANSLATION_COST_PER_1K_INPUT_TOKENS = 200;
const TRANSLATION_COST_PER_1K_OUTPUT_TOKENS = 800;

interface DeductCreditsParams {
  deviceId: string;
  transcriptionMinutes: number;
  translationInputTokens: number;
  translationOutputTokens: number;
}

// Deduct credits from a device based on usage
export const deductCredits = async ({
  deviceId,
  transcriptionMinutes,
  translationInputTokens,
  translationOutputTokens,
}: DeductCreditsParams): Promise<boolean> => {
  if (!db) throw new Error("Database not initialized");

  const transcriptionCost = Math.ceil(
    transcriptionMinutes * TRANSCRIPTION_COST_PER_MINUTE
  );
  const translationCost =
    Math.ceil(translationInputTokens / 1000) *
      TRANSLATION_COST_PER_1K_INPUT_TOKENS +
    Math.ceil(translationOutputTokens / 1000) *
      TRANSLATION_COST_PER_1K_OUTPUT_TOKENS;

  const totalCost = transcriptionCost + translationCost;

  if (totalCost <= 0) {
    console.log(`No credits to deduct for device ${deviceId}. Usage was zero.`);
    return true; // Nothing to deduct
  }

  try {
    const stmt = db.prepare(
      `UPDATE credits
         SET credit_balance = credit_balance - ?,
             updated_at      = CURRENT_TIMESTAMP
       WHERE device_id = ? AND credit_balance >= ?`
    );

    const res = await stmt.bind(totalCost, deviceId, totalCost).run();

    if ((res.meta?.changes ?? 0) > 0) {
      console.log(`Deducted ${totalCost} credits from device ${deviceId}.`);
      return true;
    } else {
      console.warn(
        `Failed to deduct ${totalCost} credits for device ${deviceId}. Insufficient balance.`
      );
      return false;
    }
  } catch (error) {
    console.error("Error deducting credits:", error);
    throw error;
  }
};
