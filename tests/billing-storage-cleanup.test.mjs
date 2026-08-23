import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import {
  cleanupExpiredDirectReplayArtifacts,
  cleanupStaleNoProgressBillingReservations,
  runBillingStorageCleanup,
} from "../src/lib/billing-storage-cleanup.ts";
import {
  getBillingReservation,
  releaseBillingReservation,
} from "../src/lib/db.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { buildReplayArtifactKey } from "../src/lib/replay-artifacts.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

function replayArtifact(key, sizeBytes = 128) {
  return {
    version: 1,
    storage: "r2",
    key,
    contentType: "application/json",
    sizeBytes,
  };
}

function insertReservation({
  deviceId,
  service = "tts",
  requestKey,
  status,
  meta,
  reservedSpend = 0,
  settledSpend = null,
  ageHours,
}) {
  sqlite
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
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`,
    )
    .run(
      deviceId,
      service,
      requestKey,
      reservedSpend,
      settledSpend,
      status,
      meta == null ? null : JSON.stringify(meta),
      `-${ageHours} hours`,
      `-${ageHours} hours`,
    );
}

test("expired direct replay cleanup claims metadata before deletion and preserves unrelated billing metadata", async () => {
  const deviceId = "81000000-0000-4000-8000-000000000001";
  const oldKey = buildReplayArtifactKey({
    service: "tts",
    deviceId,
    requestKey: "old-artifact",
  });
  const recentKey = buildReplayArtifactKey({
    service: "tts",
    deviceId,
    requestKey: "recent-artifact",
  });
  insertReservation({
    deviceId,
    requestKey: "old-artifact",
    status: "settled",
    settledSpend: 10,
    ageHours: 25,
    meta: {
      auditValue: "preserve-me",
      directReplayResult: {
        kind: "success",
        status: 200,
        artifact: replayArtifact(oldKey),
      },
      pendingFinalize: { actualSpend: 10 },
    },
  });
  insertReservation({
    deviceId,
    requestKey: "recent-artifact",
    status: "settled",
    settledSpend: 10,
    ageHours: 23,
    meta: {
      directReplayResult: {
        kind: "success",
        status: 200,
        artifact: replayArtifact(recentKey),
      },
    },
  });
  insertReservation({
    deviceId,
    requestKey: "old-inline-replay",
    status: "settled",
    settledSpend: 10,
    ageHours: 30,
    meta: {
      directReplayResult: {
        kind: "success",
        status: 200,
        data: { text: "small inline result" },
      },
    },
  });

  const deletedKeys = [];
  const bucket = {
    async delete(keys) {
      assert.ok(Array.isArray(keys));
      const claimed = await getBillingReservation({
        deviceId,
        service: "tts",
        requestKey: "old-artifact",
      });
      const claimedMeta = JSON.parse(claimed.meta);
      assert.equal("directReplayResult" in claimedMeta, false);
      assert.equal("pendingFinalize" in claimedMeta, false);
      assert.equal(claimedMeta.directReplayCleanup.artifact.key, oldKey);
      deletedKeys.push(...keys);
    },
  };

  const report = await cleanupExpiredDirectReplayArtifacts({
    bucket,
    maxAgeHours: 24,
    now: new Date("2026-08-24T00:00:00.000Z"),
  });

  assert.deepEqual(report, {
    selected: 1,
    claimed: 1,
    artifactsDeleted: 1,
    metadataCleared: 1,
    skippedInvalid: 0,
    compareAndSwapMisses: 0,
  });
  assert.deepEqual(deletedKeys, [oldKey]);

  const cleaned = await getBillingReservation({
    deviceId,
    service: "tts",
    requestKey: "old-artifact",
  });
  const cleanedMeta = JSON.parse(cleaned.meta);
  assert.equal(cleanedMeta.auditValue, "preserve-me");
  assert.equal(cleanedMeta.directReplayExpiredAt, "2026-08-24T00:00:00.000Z");
  assert.equal("directReplayCleanup" in cleanedMeta, false);
  assert.equal("directReplayResult" in cleanedMeta, false);

  const recent = await getBillingReservation({
    deviceId,
    service: "tts",
    requestKey: "recent-artifact",
  });
  assert.equal(
    JSON.parse(recent.meta).directReplayResult.artifact.key,
    recentKey,
  );
  const inline = await getBillingReservation({
    deviceId,
    service: "tts",
    requestKey: "old-inline-replay",
  });
  assert.equal(
    JSON.parse(inline.meta).directReplayResult.data.text,
    "small inline result",
  );
});

test("failed object deletion leaves a retryable cleanup marker and the next run is idempotent", async () => {
  const deviceId = "81000000-0000-4000-8000-000000000002";
  const key = buildReplayArtifactKey({
    service: "transcription",
    deviceId,
    requestKey: "retry-delete",
  });
  insertReservation({
    deviceId,
    service: "transcription",
    requestKey: "retry-delete",
    status: "settled",
    settledSpend: 5,
    ageHours: 25,
    meta: {
      directReplayResult: {
        kind: "success",
        status: 200,
        artifact: replayArtifact(key),
      },
    },
  });

  await assert.rejects(
    cleanupExpiredDirectReplayArtifacts({
      bucket: {
        async delete() {
          throw new Error("simulated R2 failure");
        },
      },
      maxAgeHours: 24,
    }),
    /simulated R2 failure/,
  );

  const pending = await getBillingReservation({
    deviceId,
    service: "transcription",
    requestKey: "retry-delete",
  });
  const pendingMeta = JSON.parse(pending.meta);
  assert.equal("directReplayResult" in pendingMeta, false);
  assert.equal(pendingMeta.directReplayCleanup.artifact.key, key);

  const deletedKeys = [];
  const retried = await cleanupExpiredDirectReplayArtifacts({
    bucket: {
      async delete(keys) {
        deletedKeys.push(...keys);
      },
    },
    maxAgeHours: 24,
  });
  assert.equal(retried.selected, 1);
  assert.equal(retried.claimed, 0);
  assert.equal(retried.artifactsDeleted, 1);
  assert.equal(retried.metadataCleared, 1);
  assert.deepEqual(deletedKeys, [key]);

  const third = await cleanupExpiredDirectReplayArtifacts({
    bucket: {
      async delete() {
        assert.fail("an idempotent third pass must not delete again");
      },
    },
    maxAgeHours: 24,
  });
  assert.equal(third.selected, 0);
  assert.equal(third.artifactsDeleted, 0);
});

test("an invalid artifact reference is never deleted and cannot starve later valid cleanup", async () => {
  const deviceId = "81000000-0000-4000-8000-000000000009";
  const invalidKey = buildReplayArtifactKey({
    service: "tts",
    deviceId,
    requestKey: "different-request",
  });
  const validKey = buildReplayArtifactKey({
    service: "tts",
    deviceId,
    requestKey: "valid-after-invalid",
  });
  insertReservation({
    deviceId,
    requestKey: "invalid-oldest",
    status: "settled",
    settledSpend: 5,
    ageHours: 26,
    meta: {
      directReplayResult: {
        kind: "success",
        status: 200,
        artifact: replayArtifact(invalidKey),
      },
    },
  });
  insertReservation({
    deviceId,
    requestKey: "valid-after-invalid",
    status: "settled",
    settledSpend: 5,
    ageHours: 25,
    meta: {
      directReplayResult: {
        kind: "success",
        status: 200,
        artifact: replayArtifact(validKey),
      },
    },
  });

  const deletedKeys = [];
  const bucket = {
    async delete(keys) {
      deletedKeys.push(...keys);
    },
  };
  const first = await cleanupExpiredDirectReplayArtifacts({
    bucket,
    maxAgeHours: 24,
    batchSize: 1,
  });
  assert.equal(first.skippedInvalid, 1);
  assert.equal(first.metadataCleared, 1);
  assert.equal(first.artifactsDeleted, 0);
  assert.deepEqual(deletedKeys, []);

  const invalid = await getBillingReservation({
    deviceId,
    service: "tts",
    requestKey: "invalid-oldest",
  });
  assert.equal("directReplayResult" in JSON.parse(invalid.meta), false);

  const second = await cleanupExpiredDirectReplayArtifacts({
    bucket,
    maxAgeHours: 24,
    batchSize: 1,
  });
  assert.equal(second.artifactsDeleted, 1);
  assert.deepEqual(deletedKeys, [validKey]);
});

test("invalid retention input falls back safely instead of widening deletion scope", async () => {
  const deviceId = "81000000-0000-4000-8000-000000000010";
  const requestKey = "recent-invalid-retention";
  const key = buildReplayArtifactKey({
    service: "tts",
    deviceId,
    requestKey,
  });
  insertReservation({
    deviceId,
    requestKey,
    status: "settled",
    settledSpend: 5,
    ageHours: 2,
    meta: {
      directReplayResult: {
        kind: "success",
        status: 200,
        artifact: replayArtifact(key),
      },
    },
  });

  const report = await cleanupExpiredDirectReplayArtifacts({
    bucket: {
      async delete() {
        assert.fail("invalid retention input must use the safe default");
      },
    },
    maxAgeHours: 0,
  });

  assert.equal(report.selected, 0);
  const retained = await getBillingReservation({
    deviceId,
    service: "tts",
    requestKey,
  });
  assert.equal(JSON.parse(retained.meta).directReplayResult.artifact.key, key);
});

test("stale no-progress reservations are refunded while recent and recoverable reservations are preserved", async () => {
  const staleDevice = "81000000-0000-4000-8000-000000000003";
  const recentDevice = "81000000-0000-4000-8000-000000000004";
  const progressDevice = "81000000-0000-4000-8000-000000000005";
  for (const [deviceId, balance] of [
    [staleDevice, 70],
    [recentDevice, 70],
    [progressDevice, 70],
  ]) {
    sqlite
      .prepare("INSERT INTO credits (device_id, credit_balance) VALUES (?, ?)")
      .run(deviceId, balance);
  }
  insertReservation({
    deviceId: staleDevice,
    service: "transcription",
    requestKey: "stale-no-progress",
    status: "reserved",
    reservedSpend: 30,
    ageHours: 25,
    meta: { directRequestLease: { version: 1 } },
  });
  insertReservation({
    deviceId: recentDevice,
    service: "transcription",
    requestKey: "recent-no-progress",
    status: "reserved",
    reservedSpend: 30,
    ageHours: 23,
    meta: {},
  });
  insertReservation({
    deviceId: progressDevice,
    service: "tts",
    requestKey: "stale-with-progress",
    status: "reserved",
    reservedSpend: 30,
    ageHours: 30,
    meta: {
      pendingFinalize: { actualSpend: 20 },
    },
  });

  const report = await cleanupStaleNoProgressBillingReservations({
    maxAgeHours: 24,
    now: new Date("2026-08-24T00:00:00.000Z"),
  });
  assert.deepEqual(report, {
    selected: 1,
    released: 1,
    refundedSpend: 30,
    skippedChanged: 0,
  });
  assert.equal(
    (await getBillingReservation({
      deviceId: staleDevice,
      service: "transcription",
      requestKey: "stale-no-progress",
    })).status,
    "released",
  );
  assert.equal(
    sqlite
      .prepare("SELECT credit_balance FROM credits WHERE device_id = ?")
      .get(staleDevice).credit_balance,
    100,
  );
  assert.equal(
    (await getBillingReservation({
      deviceId: recentDevice,
      service: "transcription",
      requestKey: "recent-no-progress",
    })).status,
    "reserved",
  );
  assert.equal(
    (await getBillingReservation({
      deviceId: progressDevice,
      service: "tts",
      requestKey: "stale-with-progress",
    })).status,
    "reserved",
  );
});

test("stale reservation cleanup cannot release a reservation whose heartbeat changed after selection", async () => {
  const deviceId = "81000000-0000-4000-8000-000000000006";
  sqlite
    .prepare("INSERT INTO credits (device_id, credit_balance) VALUES (?, ?)")
    .run(deviceId, 70);
  insertReservation({
    deviceId,
    service: "translation",
    requestKey: "compare-and-swap",
    status: "reserved",
    reservedSpend: 30,
    ageHours: 25,
    meta: {},
  });
  const selected = await getBillingReservation({
    deviceId,
    service: "translation",
    requestKey: "compare-and-swap",
  });
  sqlite
    .prepare(
      `UPDATE billing_reservations
          SET updated_at = datetime('now'), meta = '{"heartbeat":"fresh"}'
        WHERE device_id = ? AND service = ? AND request_key = ?`,
    )
    .run(deviceId, "translation", "compare-and-swap");

  const result = await releaseBillingReservation({
    deviceId,
    service: "translation",
    requestKey: "compare-and-swap",
    reason: "TEST",
    expectedUpdatedAt: selected.updated_at,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "duplicate");
  assert.equal(
    (await getBillingReservation({
      deviceId,
      service: "translation",
      requestKey: "compare-and-swap",
    })).status,
    "reserved",
  );
  assert.equal(
    sqlite
      .prepare("SELECT credit_balance FROM credits WHERE device_id = ?")
      .get(deviceId).credit_balance,
    70,
  );
});

test("orchestrated cleanup continues refunds and job cleanup when R2 replay deletion fails", async () => {
  const deviceId = "81000000-0000-4000-8000-000000000007";
  const key = buildReplayArtifactKey({
    service: "tts",
    deviceId,
    requestKey: "expired-artifact",
  });
  sqlite
    .prepare("INSERT INTO credits (device_id, credit_balance) VALUES (?, ?)")
    .run(deviceId, 90);
  insertReservation({
    deviceId,
    service: "tts",
    requestKey: "expired-artifact",
    status: "settled",
    reservedSpend: 10,
    settledSpend: 10,
    ageHours: 25,
    meta: {
      directReplayResult: {
        kind: "success",
        status: 200,
        artifact: replayArtifact(key),
      },
    },
  });
  insertReservation({
    deviceId,
    service: "translation",
    requestKey: "stale-refund",
    status: "reserved",
    reservedSpend: 10,
    ageHours: 25,
    meta: {},
  });

  const report = await runBillingStorageCleanup({
    bucket: {
      async delete(keys) {
        if (Array.isArray(keys)) {
          throw new Error("R2 unavailable");
        }
      },
    },
    directReplayMaxAgeHours: 24,
    staleReservationMaxAgeHours: 24,
  });
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /direct-replay: R2 unavailable/);
  assert.equal(report.staleReservations.released, 1);
  assert.equal(
    (await getBillingReservation({
      deviceId,
      service: "translation",
      requestKey: "stale-refund",
    })).status,
    "released",
  );
});

test("scheduled cleanup runs even when reconciliation cron is disabled", async () => {
  const deviceId = "81000000-0000-4000-8000-000000000008";
  const requestKey = "scheduled-expired-artifact";
  const key = buildReplayArtifactKey({
    service: "tts",
    deviceId,
    requestKey,
  });
  insertReservation({
    deviceId,
    service: "tts",
    requestKey,
    status: "settled",
    settledSpend: 5,
    ageHours: 25,
    meta: {
      directReplayResult: {
        kind: "success",
        status: 200,
        artifact: replayArtifact(key),
      },
    },
  });

  const deletedKeys = [];
  let scheduledWork;
  await worker.scheduled(
    {},
    {
      DB: db,
      RECONCILE_CRON_ENABLED: "0",
      DIRECT_REPLAY_RETENTION_HOURS: "24",
      STALE_BILLING_RESERVATION_MAX_AGE_HOURS: "24",
      TRANSCRIPTION_JOB_RETENTION_HOURS: "24",
      BILLING_STORAGE_CLEANUP_BATCH_SIZE: "200",
      TRANSCRIPTION_BUCKET: {
        async delete(keys) {
          if (Array.isArray(keys)) {
            deletedKeys.push(...keys);
          }
        },
      },
    },
    {
      waitUntil(promise) {
        scheduledWork = promise;
      },
    },
  );

  assert.ok(scheduledWork instanceof Promise);
  await scheduledWork;
  assert.deepEqual(deletedKeys, [key]);
  const cleaned = await getBillingReservation({
    deviceId,
    service: "tts",
    requestKey,
  });
  assert.equal(
    JSON.parse(cleaned.meta).directReplayExpiredAt.length > 0,
    true,
  );
});
