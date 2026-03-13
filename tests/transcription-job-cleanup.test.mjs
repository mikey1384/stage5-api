import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import { ensureDatabase } from "../src/lib/db/core.ts";
import {
  cleanupAbandonedPendingUploadTranscriptionJobs,
  cleanupDurableTranscriptionJobs,
} from "../src/lib/transcription-job-cleanup.ts";
import {
  getTranscriptionJob,
} from "../src/lib/db.ts";
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
      "70000000-0000-4000-8000-000000000001",
      "pending-key",
      "pending_upload",
      "transcriptions/pending-upload-old.webm",
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
      "70000000-0000-4000-8000-000000000001",
      "processing-key",
      "processing",
      "transcriptions/processing-old.webm",
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
  assert.deepEqual(deletedKeys, ["transcriptions/pending-upload-old.webm"]);
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
      "70000000-0000-4000-8000-000000000003",
      "pending-reserved-key",
      "pending_upload",
      "transcriptions/pending-upload-reserved.webm",
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
      "70000000-0000-4000-8000-000000000003",
      "pending-abandoned-key",
      "pending_upload",
      "transcriptions/pending-upload-abandoned.webm",
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
      "70000000-0000-4000-8000-000000000003",
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
  assert.deepEqual(deletedKeys, ["transcriptions/pending-upload-abandoned.webm"]);
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
      "70000000-0000-4000-8000-000000000002",
      "completed-key",
      "completed",
      "transcriptions/completed-old.webm",
      "en",
      JSON.stringify({
        version: 1,
        storage: "r2",
        key: "direct-replay/v1/transcription-job-result/completed-old.json",
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
      key: "transcriptions/completed-old.webm",
      rowStillPresent: false,
    },
    {
      key: "direct-replay/v1/transcription-job-result/completed-old.json",
      rowStillPresent: false,
    },
  ]);
});
