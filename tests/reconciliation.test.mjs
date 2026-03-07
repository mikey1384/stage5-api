import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import { ensureDatabase } from "../src/lib/db/core.ts";
import {
  createTranslationJobWithReservation,
  creditDevice,
  getBillingReservation,
  getCredits,
  getTranslationJob,
} from "../src/lib/db.ts";
import { normalizeTranslationModel } from "../src/lib/pricing.ts";
import { runReconciliation } from "../src/lib/reconciliation.ts";
import { estimateTranslationReservationCredits } from "../src/lib/relay-billing.ts";
import { buildTranslationReservationKey } from "../src/lib/translation-idempotency.ts";
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

    CREATE TABLE IF NOT EXISTS transcription_jobs (
      job_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      file_name TEXT,
      file_key TEXT,
      file_size_bytes INTEGER,
      upload_url TEXT,
      upload_expires_at DATETIME,
      result TEXT,
      error TEXT,
      duration_seconds INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS relay_translation_jobs (
      relay_job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
});

test("reconciliation settles an existing translation reservation instead of charging again", async () => {
  const deviceId = "40000000-0000-4000-8000-000000000001";
  const jobId = "translation-reconcile-completed";
  const model = normalizeTranslationModel();
  const payload = {
    mode: "chat",
    messages: [{ role: "user", content: "Hello from reconciliation" }],
    model,
  };
  const promptTokens = 640;
  const completionTokens = 220;
  const actualSpend = estimateTranslationReservationCredits({
    promptTokens,
    maxCompletionTokens: completionTokens,
    model,
    webSearchCalls: 0,
  });
  const reservationSpend = actualSpend + 175;

  await creditDevice({ deviceId, packId: "MICRO" });
  const startingCredits = (await getCredits({ deviceId }))?.credit_balance ?? 0;

  const created = await createTranslationJobWithReservation({
    jobId,
    deviceId,
    model,
    payload,
    reservationRequestKey: buildTranslationReservationKey(jobId),
    reservationSpend,
    reservationReason: "TEST_TRANSLATE_RESERVE",
    reservationMeta: { source: "test" },
  });

  assert.ok(created.ok);
  assert.equal(created.status, "created");

  sqlite
    .prepare(
      `UPDATE translation_jobs
          SET status = 'completed',
              result = ?,
              prompt_tokens = ?,
              completion_tokens = ?,
              credited = 0,
              updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?`
    )
    .run(
      JSON.stringify({
        model,
        usage: { completion_tokens: completionTokens },
        choices: [{ message: { content: "Translated output" } }],
      }),
      promptTokens,
      completionTokens,
      jobId
    );

  const report = await runReconciliation({ limit: 20 });
  assert.equal(report.translation.rebilled, 1);

  const endingCredits = (await getCredits({ deviceId }))?.credit_balance ?? 0;
  assert.equal(endingCredits, startingCredits - actualSpend);

  const job = await getTranslationJob({ jobId });
  assert.equal(job?.status, "completed");
  assert.equal(Number(job?.credited ?? 0), 1);

  const reservation = await getBillingReservation({
    deviceId,
    service: "translation",
    requestKey: buildTranslationReservationKey(jobId),
  });
  assert.equal(reservation?.status, "settled");
  assert.equal(reservation?.settled_spend, actualSpend);
});

test("reconciliation releases a reserved translation when the completed job has no result", async () => {
  const deviceId = "40000000-0000-4000-8000-000000000002";
  const jobId = "translation-reconcile-failed";
  const model = normalizeTranslationModel();
  const payload = {
    mode: "chat",
    messages: [{ role: "user", content: "Missing result" }],
    model,
  };
  const reservationSpend = 240;

  await creditDevice({ deviceId, packId: "MICRO" });
  const startingCredits = (await getCredits({ deviceId }))?.credit_balance ?? 0;

  const created = await createTranslationJobWithReservation({
    jobId,
    deviceId,
    model,
    payload,
    reservationRequestKey: buildTranslationReservationKey(jobId),
    reservationSpend,
    reservationReason: "TEST_TRANSLATE_RESERVE",
    reservationMeta: { source: "test" },
  });

  assert.ok(created.ok);
  assert.equal(created.status, "created");

  sqlite
    .prepare(
      `UPDATE translation_jobs
          SET status = 'completed',
              result = NULL,
              credited = 0,
              updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?`
    )
    .run(jobId);

  const report = await runReconciliation({ limit: 20 });
  assert.equal(report.translation.markedFailed, 1);

  const endingCredits = (await getCredits({ deviceId }))?.credit_balance ?? 0;
  assert.equal(endingCredits, startingCredits);

  const job = await getTranslationJob({ jobId });
  assert.equal(job?.status, "failed");
  assert.equal(job?.error, "reconcile:completed-without-result");

  const reservation = await getBillingReservation({
    deviceId,
    service: "translation",
    requestKey: buildTranslationReservationKey(jobId),
  });
  assert.equal(reservation?.status, "released");
});
