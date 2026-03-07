import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import {
  creditDevice,
  registerDeviceApiToken,
} from "../src/lib/db.ts";
import { buildScopedIdempotencyKey } from "../src/lib/request-utils.ts";
import { normalizeTranslationModel } from "../src/lib/pricing.ts";
import { encodeTranslationJobError } from "../src/routes/translate/error-utils.ts";
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

function buildTranslationJobId({ deviceId, requestIdempotencyKey, payload }) {
  return buildScopedIdempotencyKey({
    scope: "translation-job-v1",
    requestIdempotencyKey,
    payload: {
      deviceId,
      mode: payload.mode ?? "chat",
      messages: payload.messages ?? null,
      model: payload.model ?? null,
      modelFamily: payload.modelFamily ?? null,
      reasoning: payload.reasoning ?? null,
      translationPhase: payload.translationPhase ?? null,
      qualityMode: payload.qualityMode ?? null,
    },
  });
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS translation_jobs (
      job_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      payload TEXT,
      relay_job_id TEXT,
      result TEXT,
      error TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      credited INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
});

test("same-idempotency retries against failed translation jobs do not reserve credits", async () => {
  const deviceId = "30000000-0000-4000-8000-000000000001";
  const apiToken = await registerDeviceApiToken({ deviceId });
  await creditDevice({ deviceId, packId: "MICRO" });

  const requestIdempotencyKey = "translate-failed-retry";
  const payload = {
    mode: "chat",
    messages: [{ role: "user", content: "Hello world" }],
    model: normalizeTranslationModel(),
    modelFamily: undefined,
    reasoning: undefined,
    translationPhase: undefined,
    qualityMode: undefined,
  };
  const jobId = buildTranslationJobId({
    deviceId,
    requestIdempotencyKey,
    payload,
  });

  sqlite
    .prepare(
      `INSERT INTO translation_jobs (
         job_id,
         device_id,
         status,
         model,
         payload,
         relay_job_id,
         result,
         error,
         prompt_tokens,
         completion_tokens,
         credited,
         created_at,
         updated_at
       )
       VALUES (?, ?, 'failed', ?, ?, NULL, NULL, ?, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(
      jobId,
      deviceId,
      payload.model,
      JSON.stringify(payload),
      encodeTranslationJobError({
        message: "Prior translation failure",
        statusCode: 500,
      })
    );

  const startingCredits =
    sqlite
      .prepare("SELECT credit_balance FROM credits WHERE device_id = ?")
      .get(deviceId)?.credit_balance ?? 0;

  const response = await apiRequest("/translate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "Idempotency-Key": requestIdempotencyKey,
    },
    body: JSON.stringify({
      messages: payload.messages,
    }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Prior translation failure",
  });

  const reservationCount =
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM billing_reservations WHERE device_id = ? AND request_key = ?"
      )
      .get(deviceId, `translation-job:${jobId}`)?.count ?? 0;
  assert.equal(Number(reservationCount), 0);

  const endingCredits =
    sqlite
      .prepare("SELECT credit_balance FROM credits WHERE device_id = ?")
      .get(deviceId)?.credit_balance ?? 0;
  assert.equal(endingCredits, startingCredits);
});
