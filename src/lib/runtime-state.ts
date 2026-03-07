import crypto from "node:crypto";
import { getDatabase } from "./db/core";

let runtimeStateTableEnsured = false;

async function ensureRuntimeStateTable(): Promise<void> {
  if (runtimeStateTableEnsured) {
    return;
  }

  const db = getDatabase();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  runtimeStateTableEnsured = true;
}

export async function getRuntimeStateValue({
  stateKey,
}: {
  stateKey: string;
}): Promise<string | null> {
  await ensureRuntimeStateTable();
  const db = getDatabase();
  const row = (await db
    .prepare(
      `SELECT state_value
         FROM runtime_state
        WHERE state_key = ?
        LIMIT 1`
    )
    .bind(stateKey)
    .first()) as { state_value?: string | null } | null;

  const value =
    typeof row?.state_value === "string" ? row.state_value.trim() : "";
  return value || null;
}

export async function getOrCreateRuntimeSecret({
  stateKey,
  preferredInitialValue,
  bytes = 32,
}: {
  stateKey: string;
  preferredInitialValue?: string | null;
  bytes?: number;
}): Promise<string> {
  const existing = await getRuntimeStateValue({ stateKey });
  if (existing) {
    return existing;
  }

  const initialValue =
    typeof preferredInitialValue === "string" && preferredInitialValue.trim()
      ? preferredInitialValue.trim()
      : crypto.randomBytes(bytes).toString("base64url");

  const db = getDatabase();
  await db
    .prepare(
      `INSERT INTO runtime_state (
         state_key,
         state_value,
         created_at,
         updated_at
       )
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(state_key) DO NOTHING`
    )
    .bind(stateKey, initialValue)
    .run();

  const current = await getRuntimeStateValue({ stateKey });
  if (!current) {
    throw new Error(`Failed to read runtime state for ${stateKey}`);
  }
  return current;
}
