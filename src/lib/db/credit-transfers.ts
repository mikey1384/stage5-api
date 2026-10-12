import { createHash, randomInt } from "node:crypto";
import {
  buildRollbackIfNoChangesStatement,
  executeAtomicBatch,
  getDatabase,
  isRollbackIfNoChangesError,
} from "./core";

// Moving purchased credits (and the BYO unlock) to another device with a
// one-time code: a buyer who changes computers or reinstalls keeps what they
// paid for. There are no accounts, so the code is the proof: the old device
// makes one, the new device redeems it within 30 minutes, and everything moves
// in one transaction. Free welcome credits stay behind, so they can't be pooled.

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CODE_LENGTH = 10;
const CODE_TTL_MINUTES = 30;
const MAX_CODES_PER_HOUR = 5;
// A job that started recently may still settle against the old balance.
const ACTIVE_RESERVATION_WINDOW = "-2 hours";

export type TransferError =
  | "nothing_to_transfer"
  | "too_many_codes"
  | "jobs_running"
  | "invalid_code"
  | "same_device";

export class CreditTransferError extends Error {
  constructor(public readonly code: TransferError) {
    super(code);
  }
}

const hashCode = (code: string) =>
  createHash("sha256").update(`transfer:${code}`).digest("hex");

export const normalizeTransferCode = (raw: string) =>
  String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const formatCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

// What a device can hand over: its balance minus any welcome grant it received.
export const getTransferable = async (deviceId: string) => {
  const db = getDatabase();
  const row = (await db
    .prepare(
      `SELECT
         COALESCE((SELECT credit_balance FROM credits WHERE device_id = ?), 0) AS balance,
         COALESCE((SELECT SUM(delta) FROM credit_ledger WHERE device_id = ? AND reason = 'WELCOME'), 0) AS welcome,
         COALESCE((SELECT MAX(byo_openai, byo_anthropic) FROM entitlements WHERE device_id = ?), 0) AS byo`
    )
    .bind(deviceId, deviceId, deviceId)
    .first()) as { balance: number; welcome: number; byo: number };
  return {
    credits: Math.max(0, Number(row.balance) - Number(row.welcome)),
    welcome: Number(row.welcome),
    byoUnlock: Number(row.byo) === 1,
  };
};

const hasRecentReservation = async (deviceId: string) => {
  const db = getDatabase();
  const row = await db
    .prepare(
      `SELECT 1 FROM billing_reservations
        WHERE device_id = ? AND status = 'reserved' AND created_at > datetime('now', ?)
        LIMIT 1`
    )
    .bind(deviceId, ACTIVE_RESERVATION_WINDOW)
    .first();
  return Boolean(row);
};

export const createTransferCode = async (deviceId: string) => {
  const db = getDatabase();
  const transferable = await getTransferable(deviceId);
  if (transferable.credits === 0 && !transferable.byoUnlock) {
    throw new CreditTransferError("nothing_to_transfer");
  }
  const recent = (await db
    .prepare(
      `SELECT COUNT(*) AS n FROM credit_transfer_codes
        WHERE from_device_id = ? AND created_at > datetime('now', '-1 hour')`
    )
    .bind(deviceId)
    .first()) as { n: number };
  if (Number(recent.n) >= MAX_CODES_PER_HOUR) {
    throw new CreditTransferError("too_many_codes");
  }

  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];

  await executeAtomicBatch([
    // Only the newest code works.
    db
      .prepare(
        `UPDATE credit_transfer_codes SET expires_at = CURRENT_TIMESTAMP
          WHERE from_device_id = ? AND redeemed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`
      )
      .bind(deviceId),
    db
      .prepare(
        `INSERT INTO credit_transfer_codes (code_hash, from_device_id, expires_at)
         VALUES (?, ?, datetime('now', ?))`
      )
      .bind(hashCode(code), deviceId, `+${CODE_TTL_MINUTES} minutes`),
  ]);

  return {
    code: formatCode(code),
    expiresInMinutes: CODE_TTL_MINUTES,
    transferableCredits: transferable.credits,
    byoUnlock: transferable.byoUnlock,
  };
};

export const redeemTransferCode = async ({
  code: raw,
  toDeviceId,
}: {
  code: string;
  toDeviceId: string;
}) => {
  const db = getDatabase();
  const code = normalizeTransferCode(raw);
  if (code.length !== CODE_LENGTH) throw new CreditTransferError("invalid_code");
  const codeHash = hashCode(code);

  const pending = (await db
    .prepare(
      `SELECT from_device_id FROM credit_transfer_codes
        WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`
    )
    .bind(codeHash)
    .first()) as { from_device_id: string } | null;
  if (!pending) throw new CreditTransferError("invalid_code");
  const from = pending.from_device_id;
  if (from === toDeviceId) throw new CreditTransferError("same_device");
  if (await hasRecentReservation(from)) throw new CreditTransferError("jobs_running");

  const { welcome } = await getTransferable(from);
  const movable = `(SELECT MAX(0, credit_balance - ?) FROM credits WHERE device_id = ?)`;

  // One transaction. Claiming the code is the first statement and must change a
  // row (or everything rolls back); the rest read the old device's balance before the last statement
  // lowers it, so the credits added, the ledger entries and the deduction match.
  const statements = [
    db
      .prepare(
        `UPDATE credit_transfer_codes SET redeemed_at = CURRENT_TIMESTAMP, to_device_id = ?
          WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`
      )
      .bind(toDeviceId, codeHash),
    // A code another request just used rolls the whole transaction back.
    buildRollbackIfNoChangesStatement(`credit-transfer:${codeHash}`),
    db
      .prepare(
        `INSERT INTO credits (device_id, credit_balance, updated_at)
         SELECT ?, 0, CURRENT_TIMESTAMP
          WHERE EXISTS (SELECT 1 FROM credit_transfer_codes WHERE code_hash = ? AND to_device_id = ?)
         ON CONFLICT(device_id) DO NOTHING`
      )
      .bind(toDeviceId, codeHash, toDeviceId),
    db
      .prepare(
        `INSERT INTO credit_ledger (device_id, delta, reason, meta)
         SELECT ?, amount, 'TRANSFER_IN', json_object('fromDevice', ?)
           FROM (SELECT ${movable} AS amount)
          WHERE amount > 0
            AND EXISTS (SELECT 1 FROM credit_transfer_codes WHERE code_hash = ? AND to_device_id = ?)`
      )
      .bind(toDeviceId, from, welcome, from, codeHash, toDeviceId),
    db
      .prepare(
        `INSERT INTO credit_ledger (device_id, delta, reason, meta)
         SELECT ?, -amount, 'TRANSFER_OUT', json_object('toDevice', ?)
           FROM (SELECT ${movable} AS amount)
          WHERE amount > 0
            AND EXISTS (SELECT 1 FROM credit_transfer_codes WHERE code_hash = ? AND to_device_id = ?)`
      )
      .bind(from, toDeviceId, welcome, from, codeHash, toDeviceId),
    db
      .prepare(
        `UPDATE credits
            SET credit_balance = credit_balance + COALESCE(${movable}, 0),
                updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ?
            AND EXISTS (SELECT 1 FROM credit_transfer_codes WHERE code_hash = ? AND to_device_id = ?)`
      )
      .bind(welcome, from, toDeviceId, codeHash, toDeviceId),
    db
      .prepare(
        `INSERT INTO entitlements (device_id, byo_openai, byo_anthropic, unlocked_at, created_at, updated_at)
         SELECT ?, byo_openai, byo_anthropic, unlocked_at, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           FROM entitlements
          WHERE device_id = ? AND (byo_openai = 1 OR byo_anthropic = 1)
            AND EXISTS (SELECT 1 FROM credit_transfer_codes WHERE code_hash = ? AND to_device_id = ?)
         ON CONFLICT(device_id) DO UPDATE SET
           byo_openai = MAX(byo_openai, excluded.byo_openai),
           byo_anthropic = MAX(byo_anthropic, excluded.byo_anthropic),
           unlocked_at = COALESCE(unlocked_at, excluded.unlocked_at),
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(toDeviceId, from, codeHash, toDeviceId),
    db
      .prepare(
        `UPDATE entitlements SET byo_openai = 0, byo_anthropic = 0, updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ? AND (byo_openai = 1 OR byo_anthropic = 1)
            AND EXISTS (SELECT 1 FROM credit_transfer_codes WHERE code_hash = ? AND to_device_id = ?)`
      )
      .bind(from, codeHash, toDeviceId),
    db
      .prepare(
        `UPDATE credits
            SET credit_balance = MIN(credit_balance, ?), updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ?
            AND EXISTS (SELECT 1 FROM credit_transfer_codes WHERE code_hash = ? AND to_device_id = ?)`
      )
      .bind(welcome, from, codeHash, toDeviceId),
  ];
  try {
    await executeAtomicBatch(statements);
  } catch (error) {
    if (isRollbackIfNoChangesError(error)) throw new CreditTransferError("invalid_code");
    throw error;
  }

  const moved = (await db
    .prepare(
      `SELECT COALESCE(SUM(delta), 0) AS credits FROM credit_ledger
        WHERE device_id = ? AND reason = 'TRANSFER_IN' AND json_extract(meta, '$.fromDevice') = ?
          AND created_at >= (SELECT redeemed_at FROM credit_transfer_codes WHERE code_hash = ?)`
    )
    .bind(toDeviceId, from, codeHash)
    .first()) as { credits: number };
  const balance = (await db
    .prepare("SELECT credit_balance FROM credits WHERE device_id = ?")
    .bind(toDeviceId)
    .first()) as { credit_balance: number } | null;
  const byo = (await db
    .prepare("SELECT MAX(byo_openai, byo_anthropic) AS byo FROM entitlements WHERE device_id = ?")
    .bind(toDeviceId)
    .first()) as { byo: number } | null;

  return {
    transferredCredits: Number(moved.credits),
    creditBalance: Number(balance?.credit_balance ?? 0),
    byoUnlock: Number(byo?.byo ?? 0) === 1,
  };
};
