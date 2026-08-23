import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import { ensureDatabase } from "../src/lib/db/core.ts";
import {
  cleanupAbandonedPendingUploadTranscriptionJobs,
  cleanupDurableTranscriptionJobs,
  cleanupStaleProcessingTranscriptionJobs,
} from "../src/lib/transcription-job-cleanup.ts";
import {
  getBillingReservation,
  getTranscriptionJob,
  setTranscriptionJobProcessing,
} from "../src/lib/db.ts";
import { buildReplayArtifactKey } from "../src/lib/replay-artifacts.ts";
import { generateFileKey } from "../src/lib/r2-config.ts";
import { buildR2TranscriptionReservationKey } from "../src/lib/transcription-billing.ts";
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

test("cleanupAbandonedPendingUploadTranscriptionJobs deletes stale pending uploads without touching processing jobs", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000001";
  sqlite
    .prepare(
      `INSERT INTO transcription_jobs (
         job_id,
         device_id,
         client_request_key,
         status,
         file_key,
         language,
         duration_seconds,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-25 hours'), datetime('now', '-25 hours'))`
    )
    .run(
      "pending-upload-old",
      deviceId,
      "pending-key",
      "pending_upload",
      generateFileKey(deviceId, "pending-upload-old"),
      "en",
      120
    );

  sqlite
    .prepare(
      `INSERT INTO transcription_jobs (
         job_id,
         device_id,
         client_request_key,
         status,
         file_key,
         language,
         duration_seconds,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-25 hours'), datetime('now', '-25 hours'))`
    )
    .run(
      "processing-old",
      deviceId,
      "processing-key",
      "processing",
      generateFileKey(deviceId, "processing-old"),
      "en",
      120
    );

  const deletedKeys = [];
  const bucket = {
    async delete(key) {
      deletedKeys.push(key);
    },
  };

  const deletedCount = await cleanupAbandonedPendingUploadTranscriptionJobs({
    bucket,
    maxAgeHours: 24,
  });

  assert.equal(deletedCount, 1);
  assert.deepEqual(deletedKeys, [generateFileKey(deviceId, "pending-upload-old")]);
  assert.equal(
    await getTranscriptionJob({ jobId: "pending-upload-old" }),
    null,
  );
  assert.equal(
    (await getTranscriptionJob({ jobId: "processing-old" }))?.status,
    "processing",
  );
});

test("cleanupAbandonedPendingUploadTranscriptionJobs skips reserved pending uploads and still deletes later abandoned ones", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000003";
  sqlite
    .prepare(
      `INSERT INTO transcription_jobs (
         job_id,
         device_id,
         client_request_key,
         status,
         file_key,
         language,
         duration_seconds,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-26 hours'), datetime('now', '-26 hours'))`
    )
    .run(
      "pending-upload-reserved",
      deviceId,
      "pending-reserved-key",
      "pending_upload",
      generateFileKey(deviceId, "pending-upload-reserved"),
      "en",
      120
    );

  sqlite
    .prepare(
      `INSERT INTO transcription_jobs (
         job_id,
         device_id,
         client_request_key,
         status,
         file_key,
         language,
         duration_seconds,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-25 hours'), datetime('now', '-25 hours'))`
    )
    .run(
      "pending-upload-abandoned",
      deviceId,
      "pending-abandoned-key",
      "pending_upload",
      generateFileKey(deviceId, "pending-upload-abandoned"),
      "en",
      120
    );

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
       VALUES (?, 'transcription', ?, ?, NULL, 'reserved', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(
      deviceId,
      buildR2TranscriptionReservationKey("pending-upload-reserved"),
      42
    );

  const deletedKeys = [];
  const bucket = {
    async delete(key) {
      deletedKeys.push(key);
    },
  };

  const deletedCount = await cleanupAbandonedPendingUploadTranscriptionJobs({
    bucket,
    maxAgeHours: 24,
    batchSize: 1,
  });

  assert.equal(deletedCount, 1);
  assert.deepEqual(deletedKeys, [
    generateFileKey(deviceId, "pending-upload-abandoned"),
  ]);
  assert.equal(
    (await getTranscriptionJob({ jobId: "pending-upload-reserved" }))?.status,
    "pending_upload",
  );
  assert.equal(
    await getTranscriptionJob({ jobId: "pending-upload-abandoned" }),
    null,
  );
});

test("cleanupDurableTranscriptionJobs removes job rows before deleting stored artifacts", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000002";
  const resultKey = buildReplayArtifactKey({
    service: "transcription-job-result",
    deviceId,
    requestKey: "completed-old",
  });
  sqlite
    .prepare(
      `INSERT INTO transcription_jobs (
         job_id,
         device_id,
         client_request_key,
         status,
         file_key,
         language,
         result,
         duration_seconds,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-25 hours'), datetime('now', '-25 hours'))`
    )
    .run(
      "completed-old",
      deviceId,
      "completed-key",
      "completed",
      generateFileKey(deviceId, "completed-old"),
      "en",
      JSON.stringify({
        version: 1,
        storage: "r2",
        key: resultKey,
        contentType: "application/json",
        sizeBytes: 128,
      }),
      120,
    );

  const rowExistsAtDelete = [];
  const bucket = {
    async delete(key) {
      const row = await getTranscriptionJob({ jobId: "completed-old" });
      rowExistsAtDelete.push({
        key,
        rowStillPresent: row !== null,
      });
    },
  };

  const deletedCount = await cleanupDurableTranscriptionJobs({
    bucket,
    maxAgeHours: 24,
  });

  assert.equal(deletedCount, 1);
  assert.equal(
    await getTranscriptionJob({ jobId: "completed-old" }),
    null,
  );
  assert.deepEqual(rowExistsAtDelete, [
    {
      key: generateFileKey(deviceId, "completed-old"),
      rowStillPresent: false,
    },
    {
      key: resultKey,
      rowStillPresent: false,
    },
  ]);
});

test("durable cleanup treats batchSize as a hard per-run deletion cap", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000004";
  for (let index = 0; index < 3; index += 1) {
    sqlite
      .prepare(
        `INSERT INTO transcription_jobs (
           job_id,
           device_id,
           status,
           file_key,
           created_at,
           updated_at
         )
         VALUES (?, ?, 'completed', ?, datetime('now', '-30 hours'), datetime('now', '-25 hours'))`,
      )
      .run(
        `bounded-${index}`,
        deviceId,
        generateFileKey(deviceId, `bounded-${index}`),
      );
  }

  const deletedKeys = [];
  const deletedCount = await cleanupDurableTranscriptionJobs({
    bucket: {
      async delete(key) {
        deletedKeys.push(key);
      },
    },
    maxAgeHours: 24,
    batchSize: 2,
  });

  assert.equal(deletedCount, 2);
  assert.equal(deletedKeys.length, 2);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM transcription_jobs").get()
      .count,
    1,
  );
});

test("a processing claim wins atomically over abandoned pending-upload cleanup", async () => {
  const jobId = "pending-claimed-before-cleanup";
  const deviceId = "70000000-0000-4000-8000-000000000005";
  sqlite
    .prepare(
      `INSERT INTO transcription_jobs (
         job_id,
         device_id,
         status,
         file_key,
         created_at,
         updated_at
       )
       VALUES (?, ?, 'pending_upload', ?, datetime('now', '-25 hours'), datetime('now', '-25 hours'))`,
    )
    .run(
      jobId,
      deviceId,
      generateFileKey(deviceId, jobId),
    );
  const selected = await getTranscriptionJob({ jobId });
  assert.equal(
    await setTranscriptionJobProcessing({
      jobId,
      expectedUpdatedAt: selected.updated_at,
    }),
    true,
  );

  const deletedCount = await cleanupAbandonedPendingUploadTranscriptionJobs({
    bucket: {
      async delete() {
        assert.fail("a processing job must not have its upload deleted");
      },
    },
    maxAgeHours: 24,
  });

  assert.equal(deletedCount, 0);
  assert.equal((await getTranscriptionJob({ jobId })).status, "processing");
});

test("terminal retention is measured from the last state update, not job creation", async () => {
  const jobId = "recently-completed-old-job";
  const deviceId = "70000000-0000-4000-8000-000000000006";
  sqlite
    .prepare(
      `INSERT INTO transcription_jobs (
         job_id,
         device_id,
         status,
         file_key,
         created_at,
         updated_at
       )
       VALUES (?, ?, 'completed', ?, datetime('now', '-30 hours'), datetime('now', '-1 hour'))`,
    )
    .run(
      jobId,
      deviceId,
      generateFileKey(deviceId, jobId),
    );

  const deletedCount = await cleanupDurableTranscriptionJobs({
    bucket: {
      async delete() {
        assert.fail("a recently completed job must remain available");
      },
    },
    maxAgeHours: 24,
  });

  assert.equal(deletedCount, 0);
  assert.equal((await getTranscriptionJob({ jobId })).status, "completed");
});

test("stale processing cleanup fails the job and refunds its active reservation", async () => {
  const jobId = "processing-timeout";
  const deviceId = "70000000-0000-4000-8000-000000000007";
  sqlite
    .prepare("INSERT INTO credits (device_id, credit_balance) VALUES (?, ?)")
    .run(deviceId, 50);
  sqlite
    .prepare(
      `INSERT INTO transcription_jobs (
         job_id,
         device_id,
         status,
         file_key,
         created_at,
         updated_at
       )
       VALUES (?, ?, 'processing', ?, datetime('now', '-26 hours'), datetime('now', '-25 hours'))`,
    )
    .run(jobId, deviceId, generateFileKey(deviceId, jobId));
  sqlite
    .prepare(
      `INSERT INTO billing_reservations (
         device_id,
         service,
         request_key,
         reserved_spend,
         status,
         created_at,
         updated_at
       )
       VALUES (?, 'transcription', ?, 50, 'reserved', datetime('now', '-26 hours'), datetime('now', '-25 hours'))`,
    )
    .run(deviceId, buildR2TranscriptionReservationKey(jobId));

  const deletedKeys = [];
  const failedCount = await cleanupStaleProcessingTranscriptionJobs({
    bucket: {
      async delete(key) {
        deletedKeys.push(key);
      },
    },
    maxAgeHours: 24,
    now: new Date("2026-08-24T00:00:00.000Z"),
  });

  assert.equal(failedCount, 1);
  const job = await getTranscriptionJob({ jobId });
  assert.equal(job.status, "failed");
  assert.equal(job.error, "storage-cleanup:processing-timeout");
  assert.deepEqual(deletedKeys, [generateFileKey(deviceId, jobId)]);
  const reservation = await getBillingReservation({
    deviceId,
    service: "transcription",
    requestKey: buildR2TranscriptionReservationKey(jobId),
  });
  assert.equal(reservation.status, "released");
  assert.equal(
    sqlite
      .prepare("SELECT credit_balance FROM credits WHERE device_id = ?")
      .get(deviceId).credit_balance,
    100,
  );
});
