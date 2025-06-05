import { packs, type PackId } from "../types/packs";

// Types for database operations
export interface CreditRecord {
  device_id: string;
  minutes_remaining: number;
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
    // ② run migrations exactly once - split into separate exec() calls
    await db.exec(`
      CREATE TABLE IF NOT EXISTS credits (
        device_id         TEXT PRIMARY KEY,
        minutes_remaining INTEGER NOT NULL DEFAULT 0,
        updated_at        TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id     TEXT PRIMARY KEY,
        event_type   TEXT NOT NULL,
        processed_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
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
}: {
  deviceId: string;
  packId: PackId;
}): Promise<void> => {
  if (!db) throw new Error("Database not initialized");

  const pack = packs[packId];
  if (!pack) {
    throw new Error(`Invalid pack ID: ${packId}`);
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO credits (device_id, minutes_remaining, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        minutes_remaining = minutes_remaining + ?,
        updated_at = CURRENT_TIMESTAMP
    `);

    await stmt.bind(deviceId, pack.minutes, pack.minutes).run();
    console.log(`Added ${pack.minutes} minutes to device ${deviceId}`);
  } catch (error) {
    console.error("Error crediting device:", error);
    throw error;
  }
};

// Deduct credits from a device
export const deductCredits = async ({
  deviceId,
  minutes,
}: {
  deviceId: string;
  minutes: number;
}): Promise<boolean> => {
  if (!db) throw new Error("Database not initialized");

  try {
    const stmt = db.prepare(`
      UPDATE credits 
      SET minutes_remaining = minutes_remaining - ?, 
          updated_at = CURRENT_TIMESTAMP
      WHERE device_id = ? AND minutes_remaining >= ?
    `);

    const result = await stmt.bind(minutes, deviceId, minutes).run();
    return (result.meta?.changes ?? 0) > 0;
  } catch (error) {
    console.error("Error deducting credits:", error);
    throw error;
  }
};
