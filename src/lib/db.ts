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
let db: Database;

export const initDatabase = ({ database }: { database?: Database }) => {
  if (database) {
    db = database;
  }
  // In Workers, this will be available as env.DB
};

// Create tables if they don't exist
export const createTables = async () => {
  const createCreditsTable = `
    CREATE TABLE IF NOT EXISTS credits (
      device_id TEXT PRIMARY KEY,
      minutes_remaining INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  try {
    await db.exec(createCreditsTable);
    console.log("Database tables created successfully");
  } catch (error) {
    console.error("Error creating database tables:", error);
    throw error;
  }
};

// Get credits for a device
export const getCredits = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<CreditRecord | null> => {
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
  try {
    const stmt = db.prepare(`
      UPDATE credits 
      SET minutes_remaining = minutes_remaining - ?, 
          updated_at = CURRENT_TIMESTAMP
      WHERE device_id = ? AND minutes_remaining >= ?
    `);

    const result = await stmt.bind(minutes, deviceId, minutes).run();
    return result.changes > 0;
  } catch (error) {
    console.error("Error deducting credits:", error);
    throw error;
  }
};
