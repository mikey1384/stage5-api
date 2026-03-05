import { getDatabase } from "./core";

export interface EntitlementRecord {
  device_id: string;
  byo_openai: number;
  byo_anthropic: number;
  unlocked_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export const getEntitlementsRecord = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<EntitlementRecord | null> => {
  const db = getDatabase();

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
  const db = getDatabase();

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
  const db = getDatabase();

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
