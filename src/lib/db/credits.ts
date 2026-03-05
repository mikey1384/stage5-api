import { type PackId, packs } from "../../types/packs";
import {
  charactersToCredits,
  estimateVoiceCloningCredits,
  secondsToCredits,
  tokensToCredits,
  type TTSModel,
} from "../pricing";
import { DEFAULT_STAGE5_TRANSLATION_MODEL } from "../model-catalog";
import { getDatabase } from "./core";

export interface CreditRecord {
  device_id: string;
  credit_balance: number;
  updated_at: string;
}

export const getCredits = async ({
  deviceId,
}: {
  deviceId: string;
}): Promise<CreditRecord | null> => {
  const db = getDatabase();

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
  meta,
}: {
  deviceId: string;
  packId: PackId;
  isAdminReset?: boolean;
  meta?: Record<string, unknown>;
}): Promise<void> => {
  const db = getDatabase();

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
    const baseMeta = isAdminReset
      ? { pack: packId }
      : { packId, creditsAdded: creditsToAdd };
    const ledgerMeta = meta ? { ...baseMeta, ...meta } : baseMeta;
    await recordLedger({
      deviceId,
      delta: +creditsToAdd,
      reason: isAdminReset ? "ADMIN_RESET" : `PACK_${packId.toUpperCase()}`,
      meta: ledgerMeta,
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
  const db = getDatabase();

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
  const db = getDatabase();

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
  const db = getDatabase();

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
  model = DEFAULT_STAGE5_TRANSLATION_MODEL,
  idempotencyKey,
}: {
  deviceId: string;
  promptTokens: number;
  completionTokens: number;
  model?: string;
  idempotencyKey?: string;
}): Promise<boolean> => {
  const spend = tokensToCredits({
    prompt: promptTokens,
    completion: completionTokens,
    model,
  });
  const reason = "TRANSLATE";
  const meta = { promptTokens, completionTokens, model };
  if (idempotencyKey) {
    return updateBalanceIdempotent(deviceId, spend, {
      reason,
      meta,
      idempotencyKey,
    });
  }
  return updateBalance(deviceId, spend, { reason, meta });
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
  idempotencyKey,
}: {
  deviceId: string;
  characters: number;
  model: TTSModel;
  meta?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<boolean> => {
  const spend = charactersToCredits({ characters, model });
  const reason = "DUB";
  const billingMeta = { characters, model, ...(meta ?? {}) };
  if (idempotencyKey) {
    return updateBalanceIdempotent(deviceId, spend, {
      reason,
      meta: billingMeta,
      idempotencyKey,
    });
  }
  return updateBalance(deviceId, spend, {
    reason,
    meta: billingMeta,
  });
};

/**
 * Deduct credits for voice cloning (ElevenLabs Dubbing API) based on duration
 */
export const deductVoiceCloningCredits = async ({
  deviceId,
  durationSeconds,
  meta,
  idempotencyKey,
}: {
  deviceId: string;
  durationSeconds: number;
  meta?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<boolean> => {
  const { credits: spend } = estimateVoiceCloningCredits({ durationSeconds });
  const reason = "VOICE_CLONE";
  const billingMeta = { durationSeconds, ...(meta ?? {}) };
  if (idempotencyKey) {
    return updateBalanceIdempotent(deviceId, spend, {
      reason,
      meta: billingMeta,
      idempotencyKey,
    });
  }
  return updateBalance(deviceId, spend, {
    reason,
    meta: billingMeta,
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
  const db = getDatabase();

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
  const db = getDatabase();

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
