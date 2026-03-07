import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, beforeEach } from "node:test";

import {
  creditDevice,
  ensureDatabase,
  findBillingReservationByRelayRetryHint,
  getBillingReservation,
  getCredits,
  releaseBillingReservation,
  reserveBillingCredits,
} from "../src/lib/db.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
});

function hashText(input, size = 24) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, size);
}

function buildRelayRequestKey({ service, deviceId, clientIdempotencyKey, payload }) {
  const normalizedPayload = JSON.stringify(payload ?? null);
  return `${service}:device:${hashText(deviceId)}:req:${hashText(
    clientIdempotencyKey.trim()
  )}:payload:${hashText(normalizedPayload)}`;
}

test("D1 duplicate reservation retries return duplicate instead of insufficient credits", async () => {
  const deviceId = "20000000-0000-4000-8000-000000000001";
  await creditDevice({ deviceId, packId: "MICRO" });
  const credits = await getCredits({ deviceId });
  const spend = credits?.credit_balance ?? 0;

  assert.ok(spend > 0);

  const [first, second] = await Promise.all([
    reserveBillingCredits({
      deviceId,
      service: "translation",
      requestKey: "translation:duplicate-retry",
      spend,
      reason: "TEST",
    }),
    reserveBillingCredits({
      deviceId,
      service: "translation",
      requestKey: "translation:duplicate-retry",
      spend,
      reason: "TEST",
    }),
  ]);

  const statuses = new Set([
    first.ok ? first.status : first.error,
    second.ok ? second.status : second.error,
  ]);

  assert.deepEqual(statuses, new Set(["reserved", "duplicate"]));

  const duplicate = first.ok && first.status === "duplicate" ? first : second;
  assert.ok(duplicate.ok);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.reservation?.status, "reserved");

  const remaining = await getCredits({ deviceId });
  assert.equal(remaining?.credit_balance ?? null, 0);
});

test("relay retry hint lookup excludes refunded released reservations", async () => {
  const deviceId = "20000000-0000-4000-8000-000000000002";
  const clientIdempotencyKey = "retryable-direct-translation";
  const requestKey = buildRelayRequestKey({
    service: "translation",
    deviceId,
    clientIdempotencyKey,
    payload: { messages: [{ role: "user", content: "hello" }] },
  });

  await creditDevice({ deviceId, packId: "MICRO" });
  const reserved = await reserveBillingCredits({
    deviceId,
    service: "translation",
    requestKey,
    spend: 50,
    reason: "TEST",
  });

  assert.ok(reserved.ok);
  assert.equal(reserved.status, "reserved");

  const released = await releaseBillingReservation({
    deviceId,
    service: "translation",
    requestKey,
    reason: "TEST",
    meta: {
      releaseReason: "actual-spend-exceeds-reserve",
      directReplayResult: {
        kind: "success",
        status: 200,
        body: { text: "already-computed" },
      },
    },
  });

  assert.ok(released.ok);

  const releasedReservation = await getBillingReservation({
    deviceId,
    service: "translation",
    requestKey,
  });

  assert.equal(releasedReservation?.status, "released");
  assert.deepEqual(JSON.parse(releasedReservation?.meta ?? "{}"), {
    releaseReason: "actual-spend-exceeds-reserve",
  });

  const retryHint = await findBillingReservationByRelayRetryHint({
    deviceId,
    service: "translation",
    clientIdempotencyKey,
  });

  assert.equal(retryHint, null);
});

test("released reservations are re-reserved instead of replayed as duplicates", async () => {
  const deviceId = "20000000-0000-4000-8000-000000000003";
  await creditDevice({ deviceId, packId: "MICRO" });
  const startingCredits = await getCredits({ deviceId });
  const requestKey = "translation:released-replay";
  const spend = 75;

  const reserved = await reserveBillingCredits({
    deviceId,
    service: "translation",
    requestKey,
    spend,
    reason: "TEST",
  });

  assert.ok(reserved.ok);
  assert.equal(reserved.status, "reserved");

  const released = await releaseBillingReservation({
    deviceId,
    service: "translation",
    requestKey,
    reason: "TEST",
    meta: {
      releaseReason: "actual-spend-exceeds-reserve",
      directReplayResult: {
        kind: "success",
        status: 200,
        body: { text: "cached-result" },
      },
    },
  });

  assert.ok(released.ok);

  const retried = await reserveBillingCredits({
    deviceId,
    service: "translation",
    requestKey,
    spend,
    reason: "TEST",
  });

  assert.ok(retried.ok);
  assert.equal(retried.status, "reserved");

  const endingCredits = await getCredits({ deviceId });
  assert.equal(
    endingCredits?.credit_balance ?? null,
    (startingCredits?.credit_balance ?? 0) - spend
  );
});
