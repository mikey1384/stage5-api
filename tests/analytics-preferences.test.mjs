import assert from "node:assert/strict";
import test, { before, beforeEach, afterEach } from "node:test";
import { randomUUID } from "node:crypto";
import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { registerDeviceApiToken } from "../src/lib/db/api-tokens.ts";
import { saveAnalyticsPreference, readAnalyticsPreference } from "../src/lib/analytics-preferences.ts";
import { enqueueAnalyticsEvent, flushAnalyticsOutbox } from "../src/lib/product-analytics.ts";
import { discardIneligibleAnalytics, PENDING_ANALYTICS_RETENTION_MS } from "../src/lib/analytics-retention.ts";
import { createSqliteD1Database, resetSqliteD1Database } from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();
const env = { DB: db, GA4_TRANSLATOR_MEASUREMENT_ID: "G-TEST", GA4_API_SECRET: "test-only", ANALYTICS_PSEUDONYM_SECRET: "test-only" };
const originalFetch = globalThis.fetch;
const subject = "translator-device:test-device";
const event = { eventId: "test-event", eventName: "app_open", subjectKey: subject, params: { app_locale: "ko" } };
before(async () => { await ensureDatabase({ DB: db }); });
beforeEach(() => { resetSqliteD1Database(sqlite); globalThis.fetch = async () => { throw new Error("unexpected analytics request"); }; });
afterEach(() => { globalThis.fetch = originalFetch; });

test("default denial and stale revisions do not collect; withdrawal clears pending details atomically", async () => {
  assert.deepEqual(await readAnalyticsPreference(env, subject), { enabled: false, revision: 0 });
  assert.equal(await enqueueAnalyticsEvent(env, event), "excluded");
  await saveAnalyticsPreference(env, subject, { enabled: true, revision: 1 });
  assert.equal(await enqueueAnalyticsEvent(env, { ...event, consentRevision: 0 }), "excluded");
  assert.equal(await enqueueAnalyticsEvent(env, { ...event, consentRevision: 1 }), "queued");
  await saveAnalyticsPreference(env, subject, { enabled: false, revision: 3 });
  assert.deepEqual(await saveAnalyticsPreference(env, subject, { enabled: true, revision: 2 }), { enabled: false, revision: 3 });
  const row = sqlite.prepare("SELECT * FROM analytics_outbox").get();
  assert.equal(row.client_id, ""); assert.equal(row.params_json, "{}");
  assert.equal(row.sent_at, null); assert.ok(row.discarded_at);
  assert.equal(row.discard_reason, "consent_withdrawn");
  assert.equal((await flushAnalyticsOutbox(env)).selected, 0);
  await saveAnalyticsPreference(env, subject, { enabled: true, revision: 4 });
  assert.equal(await enqueueAnalyticsEvent(env, event), "duplicate");
  assert.equal((await flushAnalyticsOutbox(env)).sent, 0);
});

test("72-hour expiry uses original event time, preserves receipts and skips expired rows beyond cleanup batch", async () => {
  await saveAnalyticsPreference(env, subject, { enabled: true, revision: 1 });
  assert.equal(await enqueueAnalyticsEvent(env, { ...event, occurredAt: new Date(Date.now() - PENDING_ANALYTICS_RETENTION_MS) }), "excluded");
  assert.equal(await enqueueAnalyticsEvent(env, { ...event, occurredAt: new Date(Date.now() + 6 * 60 * 1000) }), "excluded");
  await enqueueAnalyticsEvent(env, event);
  const row = sqlite.prepare("SELECT client_id FROM analytics_outbox").get();
  const boundary = new Date();
  const cutoff = (boundary.getTime() - PENDING_ANALYTICS_RETENTION_MS) * 1000;
  sqlite.prepare("UPDATE analytics_outbox SET occurred_at_micros = ?").run(cutoff);
  for (let i = 0; i < 501; i++) sqlite.prepare(`INSERT INTO analytics_outbox
    (event_id,event_name,client_id,params_json,occurred_at_micros,available_at)
    VALUES (?,'purchase',?,'{"value":1}',?, '2000-01-01')`).run(`old-${i}`, row.client_id, cutoff);
  assert.deepEqual(await discardIneligibleAnalytics(boundary), { discarded: 500 });
  assert.equal((await flushAnalyticsOutbox(env)).sent, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM analytics_outbox WHERE discarded_at IS NOT NULL").get().n, 502);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM analytics_outbox WHERE sent_at IS NOT NULL").get().n, 0);
});

test("withdrawal during selection prevents the later event in the selected batch from being sent", async () => {
  await saveAnalyticsPreference(env, subject, { enabled: true, revision: 1 });
  await enqueueAnalyticsEvent(env, event);
  await enqueueAnalyticsEvent(env, { ...event, eventId: "second-event" });
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    assert.deepEqual(JSON.parse(init.body).consent, { ad_user_data: "DENIED", ad_personalization: "DENIED" });
    await saveAnalyticsPreference(env, subject, { enabled: false, revision: 2 });
    return new Response(null, { status: 204 });
  };
  await flushAnalyticsOutbox(env);
  assert.equal(requests, 1); // An already dispatched request cannot be recalled.
  assert.equal(sqlite.prepare("SELECT sent_at FROM analytics_outbox WHERE event_id = 'second-event'").get().sent_at, null);
});

test("preference API authenticates, validates, reads back and acknowledges legacy clients without events", async () => {
  const deviceId = randomUUID();
  const token = await registerDeviceApiToken({ deviceId });
  const request = (path, body, authenticated = true) => worker.fetch(new Request(`https://local.test/analytics/${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal((await request("preferences", null, false)).status, 401);
  assert.equal((await request("preferences", { enabled: "true", revision: 1 })).status, 400);
  assert.deepEqual(await (await request("preferences", { enabled: true, revision: 1 })).json(), { enabled: true, revision: 1 });
  assert.deepEqual(await (await request("preferences")).json(), { enabled: true, revision: 1 });
  const legacy = await request("events", { eventId: randomUUID(), event: "app_open", appVersion: "1.19.0", platform: "darwin", architecture: "arm64", locale: "en" });
  assert.equal(legacy.status, 202); assert.equal((await legacy.json()).excluded, true);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM analytics_outbox").get().n, 0);
});
