import {
  buildRollbackIfNoChangesStatement,
  executeAtomicBatch,
  getDatabase,
  hasAtomicBatch,
  isRollbackIfNoChangesError,
  runInTransaction,
} from "./core";
import crypto from "node:crypto";

export type BillingReservationStatus = "reserved" | "settled" | "released";

export interface BillingReservationRecord {
  device_id: string;
  service: string;
  request_key: string;
  reserved_spend: number;
  settled_spend: number | null;
  status: BillingReservationStatus;
  meta: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function serializeMeta(meta: unknown): string {
  return JSON.stringify(meta ?? null);
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty object.
  }
  return {};
}

function buildReactivatedReservationMeta(
  existingMetaRaw: string | null | undefined,
  incomingMeta: unknown
): string {
  const existingMeta = parseMeta(existingMetaRaw);
  const mergedMeta = {
    ...existingMeta,
    ...(incomingMeta && typeof incomingMeta === "object"
      ? (incomingMeta as Record<string, unknown>)
      : {}),
  };
  // Released reservations represent refunded/aborted work. Never carry stale
  // replay artifacts or release markers into a new active reservation.
  delete (mergedMeta as Record<string, unknown>).directReplayResult;
  delete (mergedMeta as Record<string, unknown>).pendingFinalize;
  delete (mergedMeta as Record<string, unknown>).releasedReplayable;
  delete (mergedMeta as Record<string, unknown>).releaseReason;
  delete (mergedMeta as Record<string, unknown>).reservedSpend;
  delete (mergedMeta as Record<string, unknown>).actualSpend;
  return serializeMeta(mergedMeta);
}

function buildReleasedReservationMeta(meta: unknown): string {
  const sanitizedMeta =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? { ...(meta as Record<string, unknown>) }
      : {};

  // Released reservations always mean the reserved credits were returned.
  // Keeping replay/finalize artifacts on a refunded row makes later retries
  // look like successful duplicates even though the billing was rolled back.
  delete sanitizedMeta.directReplayResult;
  delete sanitizedMeta.pendingFinalize;
  delete sanitizedMeta.releasedReplayable;

  return serializeMeta(sanitizedMeta);
}

// A retry can safely reuse any still-live reservation. Released reservations
// are refunded rows and must be re-reserved instead of replayed as success.
function isReplayableDuplicateReservation(
  reservation: BillingReservationRecord | null | undefined
): boolean {
  if (!reservation) {
    return false;
  }
  return reservation.status === "reserved" || reservation.status === "settled";
}

function asReplayableDuplicateReservation(
  reservation: BillingReservationRecord | null | undefined
): BillingReservationRecord | null {
  return reservation && isReplayableDuplicateReservation(reservation)
    ? reservation
    : null;
}

function buildDuplicateReservationResult(reservation: BillingReservationRecord) {
  return { ok: true, status: "duplicate", reservation } as const;
}

function buildInsufficientCreditsResult() {
  return { ok: false, error: "insufficient-credits" } as const;
}

function hashText(value: string, size = 24): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, size);
}

function buildRelayRetryRequestKeyPrefix({
  deviceId,
  service,
  clientIdempotencyKey,
}: {
  deviceId: string;
  service: string;
  clientIdempotencyKey: string;
}): string {
  const requestHash = hashText(clientIdempotencyKey.trim());
  const deviceHash = hashText(deviceId);
  return `${service}:device:${deviceHash}:req:${requestHash}:payload:`;
}

export async function getBillingReservation({
  deviceId,
  service,
  requestKey,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
}): Promise<BillingReservationRecord | null> {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT *
       FROM billing_reservations
      WHERE device_id = ?
        AND service = ?
        AND request_key = ?
      LIMIT 1`
  );
  const row = await stmt.bind(deviceId, service, requestKey).first();
  return (row as BillingReservationRecord) ?? null;
}

async function getReplayableDuplicateReservation({
  deviceId,
  service,
  requestKey,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
}): Promise<BillingReservationRecord | null> {
  return asReplayableDuplicateReservation(
    await getBillingReservation({ deviceId, service, requestKey })
  );
}

async function resolveReserveRetryRace({
  deviceId,
  service,
  requestKey,
  spend,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
  spend: number;
}): Promise<
  | ReturnType<typeof buildDuplicateReservationResult>
  | ReturnType<typeof buildInsufficientCreditsResult>
  | null
> {
  const duplicate = await getReplayableDuplicateReservation({
    deviceId,
    service,
    requestKey,
  });
  if (duplicate) {
    return buildDuplicateReservationResult(duplicate);
  }
  if (spend > 0) {
    return buildInsufficientCreditsResult();
  }
  return null;
}

export async function findBillingReservationByRelayRetryHint({
  deviceId,
  service,
  clientIdempotencyKey,
}: {
  deviceId: string;
  service: string;
  clientIdempotencyKey: string;
}): Promise<BillingReservationRecord | null> {
  const normalizedKey = String(clientIdempotencyKey || "").trim();
  if (!deviceId || !service || !normalizedKey) {
    return null;
  }

  const db = getDatabase();
  const prefix = `${buildRelayRetryRequestKeyPrefix({
    deviceId,
    service,
    clientIdempotencyKey: normalizedKey,
  })}%`;
  const result = await db
    .prepare(
      `SELECT *
         FROM billing_reservations
        WHERE device_id = ?
          AND service = ?
          AND request_key LIKE ?
          AND status IN ('reserved', 'settled', 'released')
        ORDER BY
          CASE status
            WHEN 'reserved' THEN 0
            WHEN 'settled' THEN 1
            WHEN 'released' THEN 2
            ELSE 3
          END,
          updated_at DESC
        LIMIT 4`
    )
    .bind(deviceId, service, prefix)
    .all();

  const rows = (
    Array.isArray(result?.results)
      ? (result.results as BillingReservationRecord[])
      : []
  ).filter(isReplayableDuplicateReservation);
  if (rows.length !== 1) {
    return null;
  }
  return rows[0] ?? null;
}

export async function mergeBillingReservationMeta({
  deviceId,
  service,
  requestKey,
  meta,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
  meta: unknown;
}): Promise<
  | { ok: true; reservation: BillingReservationRecord }
  | { ok: false; error: "missing-reservation" | "reservation-not-active" }
> {
  const reservation = await getBillingReservation({ deviceId, service, requestKey });
  if (!reservation) {
    return { ok: false, error: "missing-reservation" };
  }
  if (reservation.status !== "reserved" && reservation.status !== "settled") {
    return { ok: false, error: "reservation-not-active" };
  }

  const mergedMeta = {
    ...parseMeta(reservation.meta),
    ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}),
  };

  const db = getDatabase();
  await db
    .prepare(
      `UPDATE billing_reservations
          SET meta = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE device_id = ?
          AND service = ?
          AND request_key = ?`
    )
    .bind(serializeMeta(mergedMeta), deviceId, service, requestKey)
    .run();

  const updated = await getBillingReservation({ deviceId, service, requestKey });
  if (!updated) {
    return { ok: false, error: "missing-reservation" };
  }
  return { ok: true, reservation: updated };
}

export async function confirmExistingBillingReservation({
  deviceId,
  service,
  requestKey,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
}): Promise<
  | { ok: true; reservation: BillingReservationRecord }
  | { ok: false; error: "missing-reservation" | "reservation-not-active" }
> {
  const reservation = await getBillingReservation({ deviceId, service, requestKey });
  if (!reservation) {
    return { ok: false, error: "missing-reservation" };
  }
  if (reservation.status !== "reserved") {
    return { ok: false, error: "reservation-not-active" };
  }
  return { ok: true, reservation };
}

export async function increaseBillingReservation({
  deviceId,
  service,
  requestKey,
  requiredSpend,
  reason,
  meta,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
  requiredSpend: number;
  reason: string;
  meta?: unknown;
}): Promise<
  | { ok: true; status: "reserved"; reservedSpend: number }
  | { ok: true; status: "duplicate"; reservation: BillingReservationRecord }
  | {
      ok: false;
      error:
        | "missing-reservation"
        | "reservation-not-active"
        | "insufficient-credits";
    }
> {
  if (!Number.isFinite(requiredSpend) || requiredSpend < 0) {
    throw new Error(`Invalid required spend: ${requiredSpend}`);
  }

  const reservation = await getBillingReservation({ deviceId, service, requestKey });
  if (!reservation) {
    return { ok: false, error: "missing-reservation" };
  }
  if (reservation.status === "settled") {
    return { ok: true, status: "duplicate", reservation };
  }
  if (reservation.status !== "reserved") {
    return { ok: false, error: "reservation-not-active" };
  }
  if (requiredSpend <= reservation.reserved_spend) {
    return {
      ok: true,
      status: "reserved",
      reservedSpend: reservation.reserved_spend,
    };
  }
  const delta = requiredSpend - reservation.reserved_spend;

  const db = getDatabase();
  const mergedMeta = {
    ...parseMeta(reservation.meta),
    ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}),
  };
  const metaJson = serializeMeta(mergedMeta);

  if (hasAtomicBatch(db)) {
    try {
      await executeAtomicBatch([
        db
          .prepare(
            `UPDATE credits
                SET credit_balance = credit_balance - ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE device_id = ?
                AND credit_balance >= ?`
          )
          .bind(delta, deviceId, delta),
        db
          .prepare(
            `UPDATE billing_reservations
                SET reserved_spend = ?,
                    meta = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE device_id = ?
                AND service = ?
                AND request_key = ?
                AND status = 'reserved'
                AND reserved_spend = ?
                AND (SELECT changes()) > 0`
          )
          .bind(
            requiredSpend,
            metaJson,
            deviceId,
            service,
            requestKey,
            reservation.reserved_spend
          ),
        buildRollbackIfNoChangesStatement(
          `increase-billing-reservation:${service}:${requestKey}`
        ),
        db
          .prepare(
            `INSERT INTO credit_ledger (device_id, delta, reason, meta)
             VALUES (?, ?, ?, ?)`
          )
          .bind(deviceId, -delta, reason, metaJson),
      ]);
      return {
        ok: true,
        status: "reserved",
        reservedSpend: requiredSpend,
      } as const;
    } catch (error: unknown) {
      if (isRollbackIfNoChangesError(error)) {
        const current = await getBillingReservation({ deviceId, service, requestKey });
        if (!current) {
          return { ok: false, error: "missing-reservation" } as const;
        }
        if (current.status === "settled") {
          return { ok: true, status: "duplicate", reservation: current } as const;
        }
        if (current.status !== "reserved") {
          return { ok: false, error: "reservation-not-active" } as const;
        }
        const currentReservedSpend =
          typeof current.reserved_spend === "number"
            ? current.reserved_spend
            : Number.parseInt(String(current.reserved_spend ?? 0), 10) || 0;
        if (currentReservedSpend >= requiredSpend) {
          return {
            ok: true,
            status: "reserved",
            reservedSpend: currentReservedSpend,
          } as const;
        }
        return { ok: false, error: "insufficient-credits" } as const;
      }
      throw error;
    }
  }

  return runInTransaction(async () => {
    const current = await getBillingReservation({ deviceId, service, requestKey });
    if (!current) {
      return { ok: false, error: "missing-reservation" } as const;
    }
    if (current.status === "settled") {
      return { ok: true, status: "duplicate", reservation: current } as const;
    }
    if (current.status !== "reserved") {
      return { ok: false, error: "reservation-not-active" } as const;
    }
    if (requiredSpend <= current.reserved_spend) {
      return {
        ok: true,
        status: "reserved",
        reservedSpend: current.reserved_spend,
      } as const;
    }

    const delta = requiredSpend - current.reserved_spend;
    const balanceUpdate = await db
      .prepare(
        `UPDATE credits
            SET credit_balance = credit_balance - ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ?
            AND credit_balance >= ?`
      )
      .bind(delta, deviceId, delta)
      .run();

    if ((balanceUpdate.meta?.changes ?? 0) <= 0) {
      throw new Error("insufficient-credits");
    }

    const reservationUpdate = await db
      .prepare(
        `UPDATE billing_reservations
            SET reserved_spend = ?,
                meta = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ?
            AND service = ?
            AND request_key = ?
            AND status = 'reserved'`
      )
      .bind(requiredSpend, metaJson, deviceId, service, requestKey)
      .run();

    if ((reservationUpdate.meta?.changes ?? 0) <= 0) {
      const duplicate = await getBillingReservation({ deviceId, service, requestKey });
      if (duplicate) {
        return { ok: true, status: "duplicate", reservation: duplicate } as const;
      }
      return { ok: false, error: "missing-reservation" } as const;
    }

    await db
      .prepare(
        `INSERT INTO credit_ledger (device_id, delta, reason, meta)
         VALUES (?, ?, ?, ?)`
      )
      .bind(deviceId, -delta, reason, metaJson)
      .run();

    return {
      ok: true,
      status: "reserved",
      reservedSpend: requiredSpend,
    } as const;
  }).catch((error: unknown) => {
    if (String((error as any)?.message || error) === "insufficient-credits") {
      return { ok: false, error: "insufficient-credits" } as const;
    }
    throw error;
  });
}

export async function reserveBillingCredits({
  deviceId,
  service,
  requestKey,
  spend,
  reason,
  meta,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
  spend: number;
  reason: string;
  meta?: unknown;
}): Promise<
  | { ok: true; status: "reserved"; reservedSpend: number }
  | { ok: true; status: "duplicate"; reservation: BillingReservationRecord }
  | { ok: false; error: "insufficient-credits" }
> {
  if (!Number.isFinite(spend) || spend < 0) {
    throw new Error(`Invalid reservation spend: ${spend}`);
  }

  const db = getDatabase();
  const metaJson = serializeMeta(meta);
  const existing = await getBillingReservation({ deviceId, service, requestKey });
  const duplicateExisting = asReplayableDuplicateReservation(existing);

  if (duplicateExisting) {
    return buildDuplicateReservationResult(duplicateExisting);
  }

  if (hasAtomicBatch(db)) {
    if (existing?.status === "released") {
      const reactivatedMetaJson = buildReactivatedReservationMeta(existing.meta, meta);
      try {
        const statements = [];
        if (spend > 0) {
          statements.push(
            db
              .prepare(
                `UPDATE credits
                    SET credit_balance = credit_balance - ?,
                        updated_at = CURRENT_TIMESTAMP
                  WHERE device_id = ?
                    AND credit_balance >= ?`
              )
              .bind(spend, deviceId, spend)
          );
        }
        statements.push(
          db
            .prepare(
              `UPDATE billing_reservations
                  SET reserved_spend = ?,
                      settled_spend = NULL,
                      status = 'reserved',
                      meta = ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?
                  AND service = ?
                  AND request_key = ?
                  AND status = 'released'
                  ${spend > 0 ? "AND (SELECT changes()) > 0" : ""}`
            )
            .bind(spend, reactivatedMetaJson, deviceId, service, requestKey)
        );
        statements.push(
          buildRollbackIfNoChangesStatement(
            `reserve-billing-reactivate:${service}:${requestKey}`
          )
        );
        if (spend > 0) {
          statements.push(
            db
              .prepare(
                `INSERT INTO credit_ledger (device_id, delta, reason, meta)
                 VALUES (?, ?, ?, ?)`
              )
              .bind(deviceId, -spend, reason, reactivatedMetaJson)
          );
        }
        await executeAtomicBatch(statements);
        return { ok: true, status: "reserved", reservedSpend: spend } as const;
      } catch (error: unknown) {
        if (isRollbackIfNoChangesError(error)) {
          // D1 rollback means either the balance check lost the race or another
          // request created/reactivated the exact same reservation first.
          const raceResult = await resolveReserveRetryRace({
            deviceId,
            service,
            requestKey,
            spend,
          });
          if (raceResult) {
            return raceResult;
          }
          throw new Error("Failed to reactivate billing reservation");
        }
        throw error;
      }
    }

    try {
      const statements = [];
      if (spend > 0) {
        statements.push(
          db
            .prepare(
              `UPDATE credits
                  SET credit_balance = credit_balance - ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?
                  AND credit_balance >= ?`
            )
            .bind(spend, deviceId, spend)
        );
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO billing_reservations (
               device_id,
               service,
               request_key,
               reserved_spend,
               settled_spend,
               status,
               meta,
               created_at,
               updated_at
             )
             SELECT ?, ?, ?, ?, NULL, 'reserved', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              ${spend > 0 ? "WHERE (SELECT changes()) > 0" : ""}`
          )
          .bind(deviceId, service, requestKey, spend, metaJson)
      );
      statements.push(
        buildRollbackIfNoChangesStatement(
          `reserve-billing-create:${service}:${requestKey}`
        )
      );
      if (spend > 0) {
        statements.push(
          db
            .prepare(
              `INSERT INTO credit_ledger (device_id, delta, reason, meta)
               VALUES (?, ?, ?, ?)`
            )
            .bind(deviceId, -spend, reason, metaJson)
        );
      }
      await executeAtomicBatch(statements);
      return { ok: true, status: "reserved", reservedSpend: spend } as const;
    } catch (error: unknown) {
      if (isRollbackIfNoChangesError(error)) {
        // The D1 batch can roll back after debiting would have failed, but by
        // then another worker may also have created the same reservation. Check
        // for the duplicate again before calling this an actual 402.
        const raceResult = await resolveReserveRetryRace({
          deviceId,
          service,
          requestKey,
          spend,
        });
        if (raceResult) {
          return raceResult;
        }
        throw new Error("Failed to create billing reservation");
      }
      const duplicate = await getReplayableDuplicateReservation({
        deviceId,
        service,
        requestKey,
      });
      if (duplicate) {
        return buildDuplicateReservationResult(duplicate);
      }
      throw error;
    }
  }

  return runInTransaction(async () => {
    const existing = await getBillingReservation({ deviceId, service, requestKey });
    const duplicateExisting = asReplayableDuplicateReservation(existing);
    if (duplicateExisting) {
      return buildDuplicateReservationResult(duplicateExisting);
    }

    if (existing?.status === "released") {
      const reactivatedMetaJson = buildReactivatedReservationMeta(existing.meta, meta);
      const reactivateRes = await db
        .prepare(
          `UPDATE billing_reservations
              SET reserved_spend = ?,
                  settled_spend = NULL,
                  status = 'reserved',
                  meta = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?
              AND service = ?
              AND request_key = ?
              AND status = 'released'`
        )
        .bind(spend, reactivatedMetaJson, deviceId, service, requestKey)
        .run();

      if ((reactivateRes.meta?.changes ?? 0) <= 0) {
        const duplicate = await getReplayableDuplicateReservation({
          deviceId,
          service,
          requestKey,
        });
        if (duplicate) {
          return buildDuplicateReservationResult(duplicate);
        }
        throw new Error("Failed to reactivate billing reservation");
      }
    } else {
      const insertRes = await db
        .prepare(
          `INSERT INTO billing_reservations (
             device_id,
             service,
             request_key,
             reserved_spend,
             settled_spend,
             status,
             meta,
             created_at,
             updated_at
           )
           VALUES (?, ?, ?, ?, NULL, 'reserved', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
        .bind(deviceId, service, requestKey, spend, metaJson)
        .run();

      if ((insertRes.meta?.changes ?? 0) <= 0) {
        const duplicate = await getReplayableDuplicateReservation({
          deviceId,
          service,
          requestKey,
        });
        if (duplicate) {
          return buildDuplicateReservationResult(duplicate);
        }
        throw new Error("Failed to create billing reservation");
      }
    }

    if (spend > 0) {
      const updateRes = await db
        .prepare(
          `UPDATE credits
              SET credit_balance = credit_balance - ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?
              AND credit_balance >= ?`
        )
        .bind(spend, deviceId, spend)
        .run();

      if ((updateRes.meta?.changes ?? 0) <= 0) {
        throw new Error("insufficient-credits");
      }

      await db
        .prepare(
          `INSERT INTO credit_ledger (device_id, delta, reason, meta)
           VALUES (?, ?, ?, ?)`
        )
        .bind(deviceId, -spend, reason, metaJson)
        .run();
    }

    return { ok: true, status: "reserved", reservedSpend: spend } as const;
  }).catch(async (error: unknown) => {
    if (String((error as any)?.message || error) === "insufficient-credits") {
      return buildInsufficientCreditsResult();
    }
    const duplicate = await getReplayableDuplicateReservation({
      deviceId,
      service,
      requestKey,
    });
    if (duplicate) {
      return buildDuplicateReservationResult(duplicate);
    }
    throw error;
  });
}

export async function settleBillingReservation({
  deviceId,
  service,
  requestKey,
  actualSpend,
  reason,
  meta,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
  actualSpend: number;
  reason: string;
  meta?: unknown;
}): Promise<
  | { ok: true; status: "settled"; reservedSpend: number; actualSpend: number }
  | { ok: true; status: "duplicate"; reservation: BillingReservationRecord }
  | { ok: false; error: "missing-reservation" | "actual-spend-exceeds-reserve" }
> {
  if (!Number.isFinite(actualSpend) || actualSpend < 0) {
    throw new Error(`Invalid actual spend: ${actualSpend}`);
  }

  const reservation = await getBillingReservation({ deviceId, service, requestKey });
  if (!reservation) {
    return { ok: false, error: "missing-reservation" };
  }
  if (reservation.status === "settled") {
    return { ok: true, status: "duplicate", reservation };
  }
  if (reservation.status !== "reserved") {
    return { ok: false, error: "missing-reservation" };
  }
  if (actualSpend > reservation.reserved_spend) {
    await releaseBillingReservation({
      deviceId,
      service,
      requestKey,
      reason,
      meta: {
        releaseReason: "actual-spend-exceeds-reserve",
        reservedSpend: reservation.reserved_spend,
        actualSpend,
        ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}),
      },
    });
    return { ok: false, error: "actual-spend-exceeds-reserve" };
  }

  const refund = reservation.reserved_spend - actualSpend;
  const db = getDatabase();
  const metaJson = serializeMeta(meta);

  if (hasAtomicBatch(db)) {
    try {
      const statements = [
        db
          .prepare(
            `UPDATE billing_reservations
                SET status = 'settled',
                    settled_spend = ?,
                    meta = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE device_id = ?
                AND service = ?
                AND request_key = ?
                AND status = 'reserved'
                AND reserved_spend = ?`
          )
          .bind(
            actualSpend,
            metaJson,
            deviceId,
            service,
            requestKey,
            reservation.reserved_spend
          ),
        buildRollbackIfNoChangesStatement(
          `settle-billing-reservation:${service}:${requestKey}`
        ),
      ];

      if (refund > 0) {
        statements.push(
          db
            .prepare(
              `UPDATE credits
                  SET credit_balance = credit_balance + ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?`
            )
            .bind(refund, deviceId),
          db
            .prepare(
              `INSERT INTO credit_ledger (device_id, delta, reason, meta)
               VALUES (?, ?, ?, ?)`
            )
            .bind(deviceId, refund, `${reason}_REFUND`, metaJson)
        );
      }

      await executeAtomicBatch(statements);
      return {
        ok: true,
        status: "settled",
        reservedSpend: reservation.reserved_spend,
        actualSpend,
      } as const;
    } catch (error: unknown) {
      if (isRollbackIfNoChangesError(error)) {
        const duplicate = await getBillingReservation({ deviceId, service, requestKey });
        if (duplicate?.status === "settled") {
          return { ok: true, status: "duplicate", reservation: duplicate } as const;
        }
        if (!duplicate || duplicate.status !== "reserved") {
          return { ok: false, error: "missing-reservation" } as const;
        }
      }
      throw error;
    }
  }

  return runInTransaction(async () => {
    const updateRes = await db
      .prepare(
        `UPDATE billing_reservations
            SET status = 'settled',
                settled_spend = ?,
                meta = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ?
            AND service = ?
            AND request_key = ?
            AND status = 'reserved'`
      )
      .bind(actualSpend, metaJson, deviceId, service, requestKey)
      .run();

    if ((updateRes.meta?.changes ?? 0) <= 0) {
      const duplicate = await getBillingReservation({ deviceId, service, requestKey });
      if (duplicate) {
        return { ok: true, status: "duplicate", reservation: duplicate } as const;
      }
      return { ok: false, error: "missing-reservation" } as const;
    }

    if (refund > 0) {
      await db
        .prepare(
          `UPDATE credits
              SET credit_balance = credit_balance + ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?`
        )
        .bind(refund, deviceId)
        .run();

      await db
        .prepare(
          `INSERT INTO credit_ledger (device_id, delta, reason, meta)
           VALUES (?, ?, ?, ?)`
        )
        .bind(deviceId, refund, `${reason}_REFUND`, metaJson)
        .run();
    }

    return {
      ok: true,
      status: "settled",
      reservedSpend: reservation.reserved_spend,
      actualSpend,
    } as const;
  });
}

export async function releaseBillingReservation({
  deviceId,
  service,
  requestKey,
  reason,
  meta,
}: {
  deviceId: string;
  service: string;
  requestKey: string;
  reason: string;
  meta?: unknown;
}): Promise<
  | { ok: true; status: "released"; refundedSpend: number }
  | { ok: true; status: "duplicate"; reservation: BillingReservationRecord | null }
  | { ok: false; error: "missing-reservation" }
> {
  const reservation = await getBillingReservation({ deviceId, service, requestKey });
  if (!reservation) {
    return { ok: false, error: "missing-reservation" };
  }
  if (reservation.status === "released") {
    return { ok: true, status: "duplicate", reservation };
  }
  if (reservation.status === "settled") {
    return { ok: true, status: "duplicate", reservation };
  }

  const db = getDatabase();
  const refund = reservation.reserved_spend;
  const metaJson = buildReleasedReservationMeta(meta);

  if (hasAtomicBatch(db)) {
    try {
      const statements = [
        db
          .prepare(
            `UPDATE billing_reservations
                SET status = 'released',
                    meta = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE device_id = ?
                AND service = ?
                AND request_key = ?
                AND status = 'reserved'
                AND reserved_spend = ?`
          )
          .bind(metaJson, deviceId, service, requestKey, reservation.reserved_spend),
        buildRollbackIfNoChangesStatement(
          `release-billing-reservation:${service}:${requestKey}`
        ),
      ];

      if (refund > 0) {
        statements.push(
          db
            .prepare(
              `UPDATE credits
                  SET credit_balance = credit_balance + ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?`
            )
            .bind(refund, deviceId),
          db
            .prepare(
              `INSERT INTO credit_ledger (device_id, delta, reason, meta)
               VALUES (?, ?, ?, ?)`
            )
            .bind(deviceId, refund, `${reason}_RELEASE`, metaJson)
        );
      }

      await executeAtomicBatch(statements);
      return { ok: true, status: "released", refundedSpend: refund } as const;
    } catch (error: unknown) {
      if (isRollbackIfNoChangesError(error)) {
        const duplicate = await getBillingReservation({ deviceId, service, requestKey });
        return { ok: true, status: "duplicate", reservation: duplicate } as const;
      }
      throw error;
    }
  }

  return runInTransaction(async () => {
    const updateRes = await db
      .prepare(
        `UPDATE billing_reservations
            SET status = 'released',
                meta = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE device_id = ?
            AND service = ?
            AND request_key = ?
            AND status = 'reserved'`
      )
      .bind(metaJson, deviceId, service, requestKey)
      .run();

    if ((updateRes.meta?.changes ?? 0) <= 0) {
      const duplicate = await getBillingReservation({ deviceId, service, requestKey });
      return { ok: true, status: "duplicate", reservation: duplicate } as const;
    }

    if (refund > 0) {
      await db
        .prepare(
          `UPDATE credits
              SET credit_balance = credit_balance + ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE device_id = ?`
        )
        .bind(refund, deviceId)
        .run();

      await db
        .prepare(
          `INSERT INTO credit_ledger (device_id, delta, reason, meta)
           VALUES (?, ?, ?, ?)`
        )
        .bind(deviceId, refund, `${reason}_RELEASE`, metaJson)
        .run();
    }

    return { ok: true, status: "released", refundedSpend: refund } as const;
  });
}
