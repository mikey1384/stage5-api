import assert from "node:assert/strict";
import test, { before, beforeEach, afterEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { registerDeviceApiToken } from "../src/lib/db/api-tokens.ts";
import {
  enqueueAnalyticsEvent,
  flushAnalyticsOutbox,
} from "../src/lib/product-analytics.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();
const originalFetch = globalThis.fetch;

const env = {
  DB: db,
  ALLOWED_ORIGINS: "https://translator.tools",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  RELAY_SECRET: "relay-secret",
  OPENAI_API_KEY: "openai-test-key",
  RECONCILE_CRON_ENABLED: "0",
  GA4_TRANSLATOR_MEASUREMENT_ID: "G-TEST123",
  GA4_API_SECRET: "ga-test-secret",
  ANALYTICS_PSEUDONYM_SECRET: "pseudonym-test-secret",
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("analytics outbox pseudonymizes subjects, deduplicates events, and sends a valid GA4 envelope", async () => {
  const subjectKey = "translator-device:11111111-1111-4111-8111-111111111111";
  const first = await enqueueAnalyticsEvent(env, {
    eventId: "purchase:pi_exact_once",
    eventName: "purchase",
    subjectKey,
    params: {
      transaction_id: "pi_exact_once",
      currency: "USD",
      value: 10,
      items: [
        {
          item_id: "credit_pack_standard",
          item_name: "Translator STANDARD credit pack",
          price: 10,
          quantity: 1,
        },
      ],
    },
  });
  const duplicate = await enqueueAnalyticsEvent(env, {
    eventId: "purchase:pi_exact_once",
    eventName: "purchase",
    subjectKey,
    params: { transaction_id: "pi_exact_once", currency: "USD", value: 10 },
  });

  assert.equal(first, "queued");
  assert.equal(duplicate, "duplicate");
  const row = sqlite
    .prepare(
      "SELECT event_name, client_id, params_json, sent_at FROM analytics_outbox WHERE event_id = ?",
    )
    .get("purchase:pi_exact_once");
  assert.equal(row.event_name, "purchase");
  assert.match(row.client_id, /^\d+\.\d+$/);
  assert.equal(String(row.client_id).includes("11111111"), false);
  assert.equal(String(row.params_json).includes("11111111"), false);
  assert.equal(row.sent_at, null);

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  };

  const report = await flushAnalyticsOutbox(env);
  assert.deepEqual(report, {
    configured: true,
    selected: 1,
    sent: 1,
    failed: 0,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.client_id, row.client_id);
  assert.equal(requests[0].body.non_personalized_ads, true);
  assert.equal(requests[0].body.events[0].name, "purchase");
  assert.equal(
    requests[0].body.events[0].params.transaction_id,
    "pi_exact_once",
  );
  assert.equal(
    sqlite
      .prepare("SELECT sent_at FROM analytics_outbox WHERE event_id = ?")
      .get("purchase:pi_exact_once").sent_at !== null,
    true,
  );
});

test("failed Measurement Protocol delivery stays pending with retry metadata", async () => {
  await enqueueAnalyticsEvent(env, {
    eventId: "app_open:retry",
    eventName: "app_open",
    subjectKey: "translator-device:retry-device",
    params: { app_version: "1.0.0" },
  });
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });

  const report = await flushAnalyticsOutbox(env);
  assert.equal(report.failed, 1);
  const row = sqlite
    .prepare(
      "SELECT sent_at, attempts, available_at, last_error FROM analytics_outbox WHERE event_id = ?",
    )
    .get("app_open:retry");
  assert.equal(row.sent_at, null);
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /HTTP 503/);
  assert.ok(Date.parse(row.available_at) > Date.now());
});

test("concurrent outbox flushes lease an event before delivery", async () => {
  await enqueueAnalyticsEvent(env, {
    eventId: "begin_checkout:concurrent",
    eventName: "begin_checkout",
    subjectKey: "translator-device:concurrent",
    params: { currency: "USD", value: 5 },
  });
  let deliveries = 0;
  globalThis.fetch = async () => {
    deliveries += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(null, { status: 204 });
  };

  await Promise.all([
    flushAnalyticsOutbox(env),
    flushAnalyticsOutbox(env),
    flushAnalyticsOutbox(env),
  ]);

  assert.equal(deliveries, 1);
  assert.notEqual(
    sqlite
      .prepare("SELECT sent_at FROM analytics_outbox WHERE event_id = ?")
      .get("begin_checkout:concurrent").sent_at,
    null,
  );
});

test("authenticated desktop product events accept only minimized allowlisted data", async () => {
  const deviceId = "22222222-2222-4222-8222-222222222222";
  const token = await registerDeviceApiToken({ deviceId });
  const sentBodies = [];
  globalThis.fetch = async (_url, init) => {
    sentBodies.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 204 });
  };

  const response = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "X-Stage5-App-Version": "1.13.22",
      },
      body: JSON.stringify({
        eventId: "33333333-3333-4333-8333-333333333333",
        event: "app_meaningful_use",
        appVersion: "1.13.22",
        platform: "darwin",
        architecture: "arm64",
        locale: "ko-KR",
        feature: "translation",
      }),
    }),
    env,
    ctx,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, duplicate: false });
  const row = sqlite
    .prepare(
      "SELECT client_id, params_json FROM analytics_outbox WHERE event_id = ?",
    )
    .get("translator:app_meaningful_use:33333333-3333-4333-8333-333333333333");
  const params = JSON.parse(row.params_json);
  assert.deepEqual(params, {
    app_version: "1.13.22",
    operating_system: "darwin",
    architecture: "arm64",
    app_locale: "ko-KR",
    feature: "translation",
    engagement_time_msec: 1,
  });
  assert.equal(String(row.client_id).includes(deviceId), false);
  assert.equal(JSON.stringify(sentBodies).includes(deviceId), false);
});

test("authenticated translation funnel events accept only the full-SRT workflow", async () => {
  const deviceId = "66666666-6666-4666-8666-666666666666";
  const token = await registerDeviceApiToken({ deviceId });
  globalThis.fetch = async () => new Response(null, { status: 204 });

  const response = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "X-Stage5-App-Version": "1.16.8",
      },
      body: JSON.stringify({
        eventId: "77777777-7777-4777-8777-777777777777",
        event: "translation_completed",
        appVersion: "1.16.8",
        platform: "darwin",
        architecture: "arm64",
        locale: "en-US",
        workflow: "full_srt",
      }),
    }),
    env,
    ctx,
  );

  assert.equal(response.status, 202);
  const row = sqlite
    .prepare("SELECT params_json FROM analytics_outbox WHERE event_id = ?")
    .get(
      "translator:translation_completed:77777777-7777-4777-8777-777777777777",
    );
  assert.deepEqual(JSON.parse(row.params_json), {
    app_version: "1.16.8",
    operating_system: "darwin",
    architecture: "arm64",
    app_locale: "en-US",
    workflow: "full_srt",
    engagement_time_msec: 1,
  });

  const invalid = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "88888888-8888-4888-8888-888888888888",
        event: "translation_started",
        appVersion: "1.16.8",
        platform: "darwin",
        architecture: "arm64",
        locale: "en-US",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(invalid.status, 400);

  const blocked = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "99999999-9999-4999-8999-999999999999",
        event: "translation_credit_blocked",
        appVersion: "1.16.7",
        platform: "darwin",
        architecture: "arm64",
        locale: "en-US",
        workflow: "full_srt",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(blocked.status, 202);
});

test("critical desktop failures accept only minimized allowlisted diagnostics", async () => {
  const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const token = await registerDeviceApiToken({ deviceId });
  globalThis.fetch = async () => new Response(null, { status: 204 });

  const response = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        event: "app_critical_failure",
        appVersion: "1.16.9",
        platform: "darwin",
        architecture: "x64",
        locale: "en-US",
        failureClass: "startup_incomplete",
        startupPhase: "module_load",
        failedAppVersion: "1.16.8",
        failedPlatform: "darwin",
        failedArchitecture: "x64",
      }),
    }),
    env,
    ctx,
  );

  assert.equal(response.status, 202);
  const row = sqlite
    .prepare("SELECT params_json FROM analytics_outbox WHERE event_id = ?")
    .get(
      "translator:app_critical_failure:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
  assert.deepEqual(JSON.parse(row.params_json), {
    app_version: "1.16.9",
    operating_system: "darwin",
    architecture: "x64",
    app_locale: "en-US",
    failure_class: "startup_incomplete",
    startup_phase: "module_load",
    failed_app_version: "1.16.8",
    failed_operating_system: "darwin",
    failed_architecture: "x64",
    engagement_time_msec: 1,
  });

  const rejectedContent = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        event: "app_critical_failure",
        appVersion: "1.16.9",
        platform: "darwin",
        architecture: "x64",
        locale: "en-US",
        failureClass: "startup_incomplete",
        startupPhase: "module_load",
        failedAppVersion: "1.16.8",
        failedPlatform: "darwin",
        failedArchitecture: "x64",
        stack: "/Users/customer/private/file.srt",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(rejectedContent.status, 400);

  const missingProcessReason = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        event: "app_critical_failure",
        appVersion: "1.16.9",
        platform: "darwin",
        architecture: "x64",
        locale: "en-US",
        failureClass: "renderer_process_gone",
        startupPhase: "runtime",
        failedAppVersion: "1.16.9",
        failedPlatform: "darwin",
        failedArchitecture: "x64",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(missingProcessReason.status, 400);
});

test("URL download recovery events expose coarse outcomes but reject browsing data", async () => {
  const deviceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const token = await registerDeviceApiToken({ deviceId });
  globalThis.fetch = async () => new Response(null, { status: 204 });

  const required = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        event: "url_download_cookie_required",
        appVersion: "1.16.10",
        platform: "darwin",
        architecture: "arm64",
        locale: "en-US",
        sourceType: "youtube",
        cookieCause: "human_verification",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(required.status, 202);
  const requiredRow = sqlite
    .prepare("SELECT params_json FROM analytics_outbox WHERE event_id = ?")
    .get(
      "translator:url_download_cookie_required:ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
  assert.deepEqual(JSON.parse(requiredRow.params_json), {
    app_version: "1.16.10",
    operating_system: "darwin",
    architecture: "arm64",
    app_locale: "en-US",
    source_type: "youtube",
    cookie_cause: "human_verification",
    engagement_time_msec: 1,
  });

  const connected = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "12121212-1212-4212-8212-121212121212",
        event: "url_cookie_connect_completed",
        appVersion: "1.16.10",
        platform: "darwin",
        architecture: "arm64",
        locale: "en-US",
        sourceType: "youtube",
        connectionContext: "download_recovery",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(connected.status, 202);

  const rejectedUrl = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "34343434-3434-4434-8434-343434343434",
        event: "url_download_started",
        appVersion: "1.16.10",
        platform: "darwin",
        architecture: "arm64",
        locale: "en-US",
        sourceType: "youtube",
        url: "https://youtube.com/watch?v=private-id",
      }),
    }),
    env,
    ctx,
  );
  assert.equal(rejectedUrl.status, 400);
});

test("internal desktop devices are acknowledged without entering customer analytics", async () => {
  const deviceId = "44444444-4444-4444-8444-444444444444";
  const token = await registerDeviceApiToken({ deviceId });
  sqlite
    .prepare(
      `INSERT INTO internal_devices (device_id, classification, source)
       VALUES (?, 'owner_dogfood', 'test')`,
    )
    .run(deviceId);

  let deliveries = 0;
  globalThis.fetch = async () => {
    deliveries += 1;
    return new Response(null, { status: 204 });
  };

  const response = await worker.fetch(
    new Request("http://localhost/analytics/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "X-Stage5-App-Version": "1.16.6",
      },
      body: JSON.stringify({
        eventId: "55555555-5555-4555-8555-555555555555",
        event: "app_open",
        appVersion: "1.16.6",
        platform: "win32",
        architecture: "x64",
        locale: "zh-TW",
      }),
    }),
    env,
    ctx,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    duplicate: false,
    excluded: true,
  });
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM analytics_outbox WHERE event_id = ?",
      )
      .get("translator:app_open:55555555-5555-4555-8555-555555555555").count,
    0,
  );
  assert.equal(deliveries, 0);
});
