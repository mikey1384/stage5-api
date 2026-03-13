import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { buildR2TranscriptionReservationKey } from "../src/lib/transcription-billing.ts";
import {
  creditDevice,
  getTranscriptionJob,
  registerDeviceApiToken,
  storeTranscriptionJobError,
} from "../src/lib/db.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();

const env = {
  DB: db,
  ALLOWED_ORIGINS: "https://translator.tools",
  UI_ORIGIN: "https://translator.tools",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  STRIPE_BYO_UNLOCK_PRICE_ID: "price_byo_unlock",
  RELAY_SECRET: "relay-secret",
  OPENAI_API_KEY: "openai-test-key",
  ELEVENLABS_API_KEY: "elevenlabs-test-key",
  R2_ACCOUNT_ID: "test-account-id",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  TRANSCRIPTION_BUCKET: {
    async delete() {},
  },
  RECONCILE_CRON_ENABLED: "0",
  RECONCILE_CRON_DRY_RUN: "0",
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

async function apiRequest(path, init = {}) {
  const request = new Request(`http://localhost${path}`, init);
  return worker.fetch(request, env, ctx);
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

test("durable upload-url retries reuse an existing job even after credits drop to zero", async () => {
  const deviceId = "60000000-0000-4000-8000-000000000001";
  const apiToken = await registerDeviceApiToken({ deviceId });
  await creditDevice({ deviceId, packId: "MICRO" });

  const body = {
    contentType: "audio/webm",
    fileSizeMB: 67.2,
    durationSeconds: 18_612,
    language: "en",
  };
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "durable-reconnect-zero-balance",
  };

  const firstResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(firstResponse.status, 200);
  const firstPayload = await firstResponse.json();
  assert.equal(firstPayload.status, "pending_upload");

  sqlite
    .prepare(
      `UPDATE credits
          SET credit_balance = 0,
              updated_at = CURRENT_TIMESTAMP
        WHERE device_id = ?`
    )
    .run(deviceId);

  const retryResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(retryResponse.status, 200);
  const retryPayload = await retryResponse.json();

  assert.equal(retryPayload.jobId, firstPayload.jobId);
  assert.equal(retryPayload.reusedJob, true);
  assert.equal(retryPayload.status, "pending_upload");
  assert.equal(retryPayload.uploadRequired, true);
});

test("durable upload-url retries create a fresh job after the previous durable job failed", async () => {
  const deviceId = "60000000-0000-4000-8000-000000000002";
  const apiToken = await registerDeviceApiToken({ deviceId });
  await creditDevice({ deviceId, packId: "MICRO" });

  const body = {
    contentType: "audio/webm",
    fileSizeMB: 67.2,
    durationSeconds: 18_612,
    language: "en",
  };
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "durable-retry-after-failure",
  };

  const firstResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(firstResponse.status, 200);
  const firstPayload = await firstResponse.json();

  await storeTranscriptionJobError({
    jobId: firstPayload.jobId,
    message: "relay-timeout",
  });

  const retryResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(retryResponse.status, 200);
  const retryPayload = await retryResponse.json();

  assert.notEqual(retryPayload.jobId, firstPayload.jobId);
  assert.equal(retryPayload.reusedJob, false);
  assert.equal(retryPayload.status, "pending_upload");
  assert.equal(retryPayload.uploadRequired, true);

  const failedJob = await getTranscriptionJob({ jobId: firstPayload.jobId });
  assert.equal(failedJob?.status, "failed");
  assert.equal(failedJob?.client_request_key, null);

  const replacementJob = await getTranscriptionJob({ jobId: retryPayload.jobId });
  assert.equal(replacementJob?.status, "pending_upload");
  assert.ok(replacementJob?.client_request_key);
});

test("durable upload-url retries reuse an existing job despite requested duration jitter", async () => {
  const deviceId = "60000000-0000-4000-8000-000000000003";
  const apiToken = await registerDeviceApiToken({ deviceId });
  await creditDevice({ deviceId, packId: "MICRO" });

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "durable-duration-jitter",
  };
  const firstBody = {
    contentType: "audio/webm",
    fileSizeMB: 67.2,
    durationSeconds: 18_612.03,
    language: "en",
  };
  const retryBody = {
    ...firstBody,
    durationSeconds: 18_612.0,
  };

  const firstResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(firstBody),
  });
  assert.equal(firstResponse.status, 200);
  const firstPayload = await firstResponse.json();

  const retryResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(retryBody),
  });
  assert.equal(retryResponse.status, 200);
  const retryPayload = await retryResponse.json();

  assert.equal(retryPayload.jobId, firstPayload.jobId);
  assert.equal(retryPayload.reusedJob, true);
});

test("durable upload-url retries replace stale pending_upload jobs instead of reusing them", async () => {
  const deviceId = "60000000-0000-4000-8000-000000000004";
  const apiToken = await registerDeviceApiToken({ deviceId });
  await creditDevice({ deviceId, packId: "MICRO" });

  const body = {
    contentType: "audio/webm",
    fileSizeMB: 67.2,
    durationSeconds: 18_612,
    language: "en",
  };
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "durable-replace-stale-pending-upload",
  };

  const firstResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(firstResponse.status, 200);
  const firstPayload = await firstResponse.json();
  assert.equal(firstPayload.status, "pending_upload");

  sqlite
    .prepare(
      `UPDATE transcription_jobs
          SET created_at = datetime('now', '-49 hours')
        WHERE job_id = ?`
    )
    .run(firstPayload.jobId);

  const retryResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(retryResponse.status, 200);
  const retryPayload = await retryResponse.json();

  assert.notEqual(retryPayload.jobId, firstPayload.jobId);
  assert.equal(retryPayload.reusedJob, false);
  assert.equal(retryPayload.status, "pending_upload");

  const staleJob = await getTranscriptionJob({ jobId: firstPayload.jobId });
  if (staleJob) {
    assert.equal(staleJob.status, "failed");
    assert.equal(staleJob.client_request_key, null);
  }
});

test("durable upload-url retries treat reserved pending uploads as already in flight", async () => {
  const deviceId = "60000000-0000-4000-8000-000000000005";
  const apiToken = await registerDeviceApiToken({ deviceId });
  await creditDevice({ deviceId, packId: "MICRO" });

  const body = {
    contentType: "audio/webm",
    fileSizeMB: 67.2,
    durationSeconds: 18_612,
    language: "en",
  };
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "durable-reserved-pending-upload",
  };

  const firstResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(firstResponse.status, 200);
  const firstPayload = await firstResponse.json();
  assert.equal(firstPayload.status, "pending_upload");

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
      buildR2TranscriptionReservationKey(firstPayload.jobId),
      42,
    );

  const retryResponse = await apiRequest("/transcribe/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(retryResponse.status, 200);
  const retryPayload = await retryResponse.json();

  assert.equal(retryPayload.jobId, firstPayload.jobId);
  assert.equal(retryPayload.reusedJob, true);
  assert.equal(retryPayload.status, "processing");
  assert.equal(retryPayload.uploadRequired, false);
  assert.equal(retryPayload.uploadUrl, null);
});
