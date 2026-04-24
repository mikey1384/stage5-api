import { packs, type PackId } from "../../types/packs";
import { getDatabase } from "./core";

export const isEventProcessed = async ({
  eventId,
}: {
  eventId: string;
}): Promise<boolean> => {
  const db = getDatabase();

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
  const db = getDatabase();

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

export const markEventProcessedIfNew = async ({
  eventId,
  eventType,
}: {
  eventId: string;
  eventType: string;
}): Promise<boolean> => {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO processed_events (event_id, event_type, processed_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id) DO NOTHING
    `);
    const result = await stmt.bind(eventId, eventType).run();
    return Number(result?.meta?.changes ?? 0) > 0;
  } catch (error) {
    console.error("Error marking event as processed if new:", error);
    throw error;
  }
};

type StripeFulfillmentKind = "credits" | "entitlement";

type StripeFulfillmentBase = {
  deviceId: string;
  checkoutSessionId?: string | null;
  paymentIntentId?: string | null;
  stripeEventId?: string | null;
  stripeEventType: string;
};

type CreditPackFulfillmentInput = StripeFulfillmentBase & {
  packId: PackId;
  stripePaymentStatus?: string | null;
};

type EntitlementFulfillmentInput = StripeFulfillmentBase & {
  entitlement: "byo_openai";
};

export type CheckoutSessionKind = "credits" | "entitlement";
export type CheckoutSessionStatus =
  | "created"
  | "fulfilled"
  | "failed"
  | "cancelled";

export interface CheckoutSessionRecord {
  checkout_session_id: string;
  checkout_return_id: string | null;
  device_id: string;
  kind: CheckoutSessionKind;
  status: CheckoutSessionStatus;
  pack_id: string | null;
  entitlement: string | null;
  credits_delta: number | null;
  payment_intent_id: string | null;
  stripe_event_id: string | null;
  stripe_event_type: string | null;
  credit_balance_after: number | null;
  entitlements_json: string | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
  fulfilled_at: string | null;
}

function serializeMeta(meta: unknown): string {
  return JSON.stringify(meta ?? null);
}

function normalizeCheckoutSessionRecord(
  row: any
): CheckoutSessionRecord | null {
  if (!row) return null;
  return {
    checkout_session_id: String(row.checkout_session_id),
    checkout_return_id:
      typeof row.checkout_return_id === "string"
        ? row.checkout_return_id
        : null,
    device_id: String(row.device_id),
    kind: row.kind === "entitlement" ? "entitlement" : "credits",
    status:
      row.status === "fulfilled" ||
      row.status === "failed" ||
      row.status === "cancelled"
        ? row.status
        : "created",
    pack_id: typeof row.pack_id === "string" ? row.pack_id : null,
    entitlement: typeof row.entitlement === "string" ? row.entitlement : null,
    credits_delta:
      typeof row.credits_delta === "number" ? row.credits_delta : null,
    payment_intent_id:
      typeof row.payment_intent_id === "string"
        ? row.payment_intent_id
        : null,
    stripe_event_id:
      typeof row.stripe_event_id === "string" ? row.stripe_event_id : null,
    stripe_event_type:
      typeof row.stripe_event_type === "string"
        ? row.stripe_event_type
        : null,
    credit_balance_after:
      typeof row.credit_balance_after === "number"
        ? row.credit_balance_after
        : null,
    entitlements_json:
      typeof row.entitlements_json === "string" ? row.entitlements_json : null,
    error_message:
      typeof row.error_message === "string" ? row.error_message : null,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    fulfilled_at:
      typeof row.fulfilled_at === "string" ? row.fulfilled_at : null,
  };
}

export async function recordCheckoutSessionCreated({
  checkoutSessionId,
  checkoutReturnId = null,
  deviceId,
  kind,
  packId = null,
  entitlement = null,
  creditsDelta = null,
}: {
  checkoutSessionId: string;
  checkoutReturnId?: string | null;
  deviceId: string;
  kind: CheckoutSessionKind;
  packId?: string | null;
  entitlement?: string | null;
  creditsDelta?: number | null;
}): Promise<void> {
  const db = getDatabase();
  await db
    .prepare(
      `INSERT INTO checkout_sessions (
         checkout_session_id,
         checkout_return_id,
         device_id,
         kind,
         status,
         pack_id,
         entitlement,
         credits_delta,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, 'created', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(checkout_session_id) DO UPDATE SET
         checkout_return_id = COALESCE(excluded.checkout_return_id, checkout_sessions.checkout_return_id),
         device_id = excluded.device_id,
         kind = excluded.kind,
         pack_id = excluded.pack_id,
         entitlement = excluded.entitlement,
         credits_delta = excluded.credits_delta,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      checkoutSessionId,
      checkoutReturnId,
      deviceId,
      kind,
      packId,
      entitlement,
      typeof creditsDelta === "number" ? creditsDelta : null
    )
    .run();
}

export async function getCheckoutSessionRecordByReturnId({
  checkoutReturnId,
  deviceId,
}: {
  checkoutReturnId: string;
  deviceId?: string | null;
}): Promise<CheckoutSessionRecord | null> {
  const db = getDatabase();
  const row = deviceId
    ? await db
        .prepare(
          `SELECT * FROM checkout_sessions
           WHERE checkout_return_id = ? AND device_id = ?`
        )
        .bind(checkoutReturnId, deviceId)
        .first()
    : await db
        .prepare(
          `SELECT * FROM checkout_sessions
           WHERE checkout_return_id = ?`
        )
        .bind(checkoutReturnId)
        .first();
  return normalizeCheckoutSessionRecord(row);
}

export async function getCheckoutSessionRecord({
  checkoutSessionId,
  deviceId,
}: {
  checkoutSessionId: string;
  deviceId?: string | null;
}): Promise<CheckoutSessionRecord | null> {
  const db = getDatabase();
  const row = deviceId
    ? await db
        .prepare(
          `SELECT * FROM checkout_sessions
           WHERE checkout_session_id = ? AND device_id = ?`
        )
        .bind(checkoutSessionId, deviceId)
        .first()
    : await db
        .prepare(
          `SELECT * FROM checkout_sessions
           WHERE checkout_session_id = ?`
        )
        .bind(checkoutSessionId)
        .first();
  return normalizeCheckoutSessionRecord(row);
}

export async function markCheckoutSessionFulfilledCredits({
  checkoutSessionId,
  deviceId,
  packId = null,
  paymentIntentId = null,
  stripeEventId = null,
  stripeEventType,
}: {
  checkoutSessionId?: string | null;
  deviceId: string;
  packId?: string | null;
  paymentIntentId?: string | null;
  stripeEventId?: string | null;
  stripeEventType: string;
}): Promise<{ balanceAfter: number; updatedAt: string | null }> {
  const db = getDatabase();
  const row = await db
    .prepare("SELECT credit_balance, updated_at FROM credits WHERE device_id = ?")
    .bind(deviceId)
    .first();
  const balanceAfter = Number(row?.credit_balance ?? 0);
  const updatedAt = typeof row?.updated_at === "string" ? row.updated_at : null;

  if (checkoutSessionId) {
    await db
      .prepare(
        `UPDATE checkout_sessions
         SET status = 'fulfilled',
             pack_id = COALESCE(?, pack_id),
             payment_intent_id = COALESCE(?, payment_intent_id),
             stripe_event_id = ?,
             stripe_event_type = ?,
             credit_balance_after = ?,
             fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE checkout_session_id = ? AND device_id = ?`
      )
      .bind(
        packId,
        paymentIntentId,
        stripeEventId,
        stripeEventType,
        balanceAfter,
        checkoutSessionId,
        deviceId
      )
      .run();
  }

  return { balanceAfter, updatedAt };
}

export async function markCheckoutSessionFulfilledEntitlement({
  checkoutSessionId,
  deviceId,
  entitlement,
  paymentIntentId = null,
  stripeEventId = null,
  stripeEventType,
}: {
  checkoutSessionId?: string | null;
  deviceId: string;
  entitlement: "byo_openai";
  paymentIntentId?: string | null;
  stripeEventId?: string | null;
  stripeEventType: string;
}): Promise<{
  entitlements: {
    byoOpenAi: boolean;
    byoAnthropic: boolean;
    byoElevenLabs: boolean;
  };
  updatedAt: string | null;
}> {
  const db = getDatabase();
  const row = await db
    .prepare(
      `SELECT byo_openai, byo_anthropic, updated_at
       FROM entitlements
       WHERE device_id = ?`
    )
    .bind(deviceId)
    .first();
  const byoOpenAi = Boolean(row?.byo_openai);
  const entitlements = {
    byoOpenAi,
    byoAnthropic: Boolean(row?.byo_anthropic) || byoOpenAi,
    byoElevenLabs: byoOpenAi,
  };
  const updatedAt = typeof row?.updated_at === "string" ? row.updated_at : null;
  const entitlementsJson = JSON.stringify(entitlements);

  if (checkoutSessionId) {
    await db
      .prepare(
        `UPDATE checkout_sessions
         SET status = 'fulfilled',
             entitlement = COALESCE(?, entitlement),
             payment_intent_id = COALESCE(?, payment_intent_id),
             stripe_event_id = ?,
             stripe_event_type = ?,
             entitlements_json = ?,
             fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE checkout_session_id = ? AND device_id = ?`
      )
      .bind(
        entitlement,
        paymentIntentId,
        stripeEventId,
        stripeEventType,
        entitlementsJson,
        checkoutSessionId,
        deviceId
      )
      .run();
  }

  return { entitlements, updatedAt };
}

export async function markCheckoutSessionFailed({
  checkoutSessionId,
  deviceId,
  paymentIntentId = null,
  stripeEventId = null,
  stripeEventType,
  errorMessage = null,
}: {
  checkoutSessionId?: string | null;
  deviceId?: string | null;
  paymentIntentId?: string | null;
  stripeEventId?: string | null;
  stripeEventType: string;
  errorMessage?: string | null;
}): Promise<void> {
  if (!checkoutSessionId) return;

  const db = getDatabase();
  await db
    .prepare(
      `UPDATE checkout_sessions
       SET status = 'failed',
           payment_intent_id = COALESCE(?, payment_intent_id),
           stripe_event_id = ?,
           stripe_event_type = ?,
           error_message = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE checkout_session_id = ?
         AND (? IS NULL OR device_id = ?)
         AND status != 'fulfilled'`
    )
    .bind(
      paymentIntentId,
      stripeEventId,
      stripeEventType,
      errorMessage,
      checkoutSessionId,
      deviceId,
      deviceId
    )
    .run();
}

export async function markCheckoutSessionCancelled({
  checkoutSessionId,
  deviceId,
  stripeEventId = null,
  stripeEventType,
  errorMessage = null,
}: {
  checkoutSessionId?: string | null;
  deviceId?: string | null;
  stripeEventId?: string | null;
  stripeEventType: string;
  errorMessage?: string | null;
}): Promise<void> {
  if (!checkoutSessionId) return;

  const db = getDatabase();
  await db
    .prepare(
      `UPDATE checkout_sessions
       SET status = 'cancelled',
           stripe_event_id = ?,
           stripe_event_type = ?,
           error_message = COALESCE(?, error_message),
           updated_at = CURRENT_TIMESTAMP
       WHERE checkout_session_id = ?
         AND (? IS NULL OR device_id = ?)
         AND status = 'created'`
    )
    .bind(
      stripeEventId,
      stripeEventType,
      errorMessage,
      checkoutSessionId,
      deviceId,
      deviceId
    )
    .run();
}

function buildStripeFulfillmentKey(
  kind: StripeFulfillmentKind,
  checkoutSessionId?: string | null,
  paymentIntentId?: string | null,
  scope?: string
): string {
  const entityId = paymentIntentId || checkoutSessionId;
  if (!entityId) {
    throw new Error(`Missing Stripe entity ID for ${kind} fulfillment`);
  }
  return scope ? `${kind}:${scope}:${entityId}` : `${kind}:${entityId}`;
}

function isStripeFulfillmentUniqueConstraintError(error: any): boolean {
  const msg = String(error?.message || error || "");
  return (
    msg.includes("UNIQUE constraint failed") &&
    msg.includes("stripe_fulfillments")
  );
}

async function runInTransaction<T>(work: () => Promise<T>): Promise<T> {
  const db = getDatabase();
  await db.exec("BEGIN");
  try {
    const result = await work();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}

export async function fulfillCreditPackPurchase({
  deviceId,
  packId,
  checkoutSessionId = null,
  paymentIntentId = null,
  stripeEventId = null,
  stripeEventType,
  stripePaymentStatus = null,
}: CreditPackFulfillmentInput): Promise<"applied" | "duplicate"> {
  const db = getDatabase();
  const pack = packs[packId];
  if (!pack) {
    throw new Error(`Invalid pack ID for Stripe fulfillment: ${packId}`);
  }

  const creditsToAdd = pack.credits;
  const reason = `PACK_${packId.toUpperCase()}`;
  const fulfillmentKey = buildStripeFulfillmentKey(
    "credits",
    checkoutSessionId,
    paymentIntentId
  );
  const metaJson = serializeMeta({
    packId,
    creditsAdded: creditsToAdd,
    checkoutSessionId,
    paymentIntentId,
    stripeEventId,
    stripeEventType,
    stripePaymentStatus,
    fulfillmentKey,
  });

  if (typeof db.batch === "function") {
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO stripe_fulfillments (
               fulfillment_key,
               device_id,
               fulfillment_kind,
               checkout_session_id,
               payment_intent_id,
               stripe_event_id,
               stripe_event_type,
               meta,
               created_at
             )
             VALUES (?, ?, 'credits', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
          )
          .bind(
            fulfillmentKey,
            deviceId,
            checkoutSessionId,
            paymentIntentId,
            stripeEventId,
            stripeEventType,
            metaJson
          ),
        db
          .prepare(
            `INSERT INTO credits (device_id, credit_balance, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id) DO UPDATE SET
               credit_balance = credit_balance + ?,
               updated_at = CURRENT_TIMESTAMP`
          )
          .bind(deviceId, creditsToAdd, creditsToAdd),
        db
          .prepare(
            `INSERT INTO credit_ledger (device_id, delta, reason, meta)
             VALUES (?, ?, ?, ?)`
          )
          .bind(deviceId, creditsToAdd, reason, metaJson),
      ]);
      return "applied";
    } catch (error) {
      if (isStripeFulfillmentUniqueConstraintError(error)) {
        return "duplicate";
      }
      throw error;
    }
  }

  try {
    await runInTransaction(async () => {
      await db
        .prepare(
          `INSERT INTO stripe_fulfillments (
             fulfillment_key,
             device_id,
             fulfillment_kind,
             checkout_session_id,
             payment_intent_id,
             stripe_event_id,
             stripe_event_type,
             meta,
             created_at
           )
           VALUES (?, ?, 'credits', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        )
        .bind(
          fulfillmentKey,
          deviceId,
          checkoutSessionId,
          paymentIntentId,
          stripeEventId,
          stripeEventType,
          metaJson
        )
        .run();

      await db
        .prepare(
          `INSERT INTO credits (device_id, credit_balance, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(device_id) DO UPDATE SET
             credit_balance = credit_balance + ?,
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(deviceId, creditsToAdd, creditsToAdd)
        .run();

      await db
        .prepare(
          `INSERT INTO credit_ledger (device_id, delta, reason, meta)
           VALUES (?, ?, ?, ?)`
        )
        .bind(deviceId, creditsToAdd, reason, metaJson)
        .run();
    });
    return "applied";
  } catch (error) {
    if (isStripeFulfillmentUniqueConstraintError(error)) {
      return "duplicate";
    }
    throw error;
  }
}

export async function fulfillByoOpenAiUnlock({
  deviceId,
  entitlement,
  checkoutSessionId = null,
  paymentIntentId = null,
  stripeEventId = null,
  stripeEventType,
}: EntitlementFulfillmentInput): Promise<"applied" | "duplicate"> {
  const db = getDatabase();
  const fulfillmentKey = buildStripeFulfillmentKey(
    "entitlement",
    checkoutSessionId,
    paymentIntentId,
    entitlement
  );
  const metaJson = serializeMeta({
    entitlement,
    checkoutSessionId,
    paymentIntentId,
    stripeEventId,
    stripeEventType,
    fulfillmentKey,
  });

  if (typeof db.batch === "function") {
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO stripe_fulfillments (
               fulfillment_key,
               device_id,
               fulfillment_kind,
               checkout_session_id,
               payment_intent_id,
               stripe_event_id,
               stripe_event_type,
               meta,
               created_at
             )
             VALUES (?, ?, 'entitlement', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
          )
          .bind(
            fulfillmentKey,
            deviceId,
            checkoutSessionId,
            paymentIntentId,
            stripeEventId,
            stripeEventType,
            metaJson
          ),
        db
          .prepare(
            `INSERT INTO entitlements (
               device_id,
               byo_openai,
               byo_anthropic,
               unlocked_at,
               created_at,
               updated_at
             )
             VALUES (?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id) DO UPDATE SET
               byo_openai = 1,
               byo_anthropic = 1,
               unlocked_at = CASE
                 WHEN entitlements.unlocked_at IS NULL THEN CURRENT_TIMESTAMP
                 ELSE entitlements.unlocked_at
               END,
               updated_at = CURRENT_TIMESTAMP`
          )
          .bind(deviceId),
      ]);
      return "applied";
    } catch (error) {
      if (isStripeFulfillmentUniqueConstraintError(error)) {
        return "duplicate";
      }
      throw error;
    }
  }

  try {
    await runInTransaction(async () => {
      await db
        .prepare(
          `INSERT INTO stripe_fulfillments (
             fulfillment_key,
             device_id,
             fulfillment_kind,
             checkout_session_id,
             payment_intent_id,
             stripe_event_id,
             stripe_event_type,
             meta,
             created_at
           )
           VALUES (?, ?, 'entitlement', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        )
        .bind(
          fulfillmentKey,
          deviceId,
          checkoutSessionId,
          paymentIntentId,
          stripeEventId,
          stripeEventType,
          metaJson
        )
        .run();

      await db
        .prepare(
          `INSERT INTO entitlements (
             device_id,
             byo_openai,
             byo_anthropic,
             unlocked_at,
             created_at,
             updated_at
           )
           VALUES (?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(device_id) DO UPDATE SET
             byo_openai = 1,
             byo_anthropic = 1,
             unlocked_at = CASE
               WHEN entitlements.unlocked_at IS NULL THEN CURRENT_TIMESTAMP
               ELSE entitlements.unlocked_at
             END,
             updated_at = CURRENT_TIMESTAMP`
        )
        .bind(deviceId)
        .run();
    });
    return "applied";
  } catch (error) {
    if (isStripeFulfillmentUniqueConstraintError(error)) {
      return "duplicate";
    }
    throw error;
  }
}
