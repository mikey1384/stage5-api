import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { registerDeviceApiToken } from "../src/lib/db/api-tokens.ts";
import { recordCheckoutSessionCreated } from "../src/lib/db/payments.ts";
import { runCheckoutSweep } from "../src/lib/checkout-sweep.ts";
import { getStripe } from "../src/lib/stripe.ts";
import { packs } from "../src/types/packs.ts";
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
  SENDGRID_API_KEY: "sendgrid-test-key",
  PAYMENT_ALERT_EMAIL_TO: "mikey@stage5.tools",
  PAYMENT_ALERT_EMAIL_FROM: "alerts@stage5.tools",
};

const ctx = { waitUntil() {}, passThroughOnException() {} };
let sentAlerts = [];
const originalFetch = globalThis.fetch;

function apiRequest(path, init = {}) {
  return worker.fetch(new Request(`http://localhost${path}`, init), env, ctx);
}

function postWebhook() {
  return apiRequest("/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "sig", "content-type": "application/json" },
    body: "{}",
  });
}

function scalar(sql, params = []) {
  const row = sqlite.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}

function row(sessionId) {
  return {
    ...sqlite
      .prepare("SELECT * FROM checkout_sessions WHERE checkout_session_id = ?")
      .get(sessionId),
  };
}

function balance(deviceId) {
  return Number(
    scalar("SELECT credit_balance FROM credits WHERE device_id = ?", [
      deviceId,
    ]) ?? 0,
  );
}

function grants(deviceId) {
  return Number(
    scalar(
      "SELECT COUNT(*) FROM credit_ledger WHERE device_id = ? AND reason LIKE 'PACK_%'",
      [deviceId],
    ),
  );
}

const stripe = getStripe(env.STRIPE_SECRET_KEY);
let nextEvent = null;
let sessionsById = new Map();
let paymentIntentsById = new Map();

function stubStripe() {
  stripe.webhooks.constructEventAsync = async () => {
    if (!nextEvent) throw new Error("No signatures found matching the expected signature for payload");
    return typeof nextEvent === "function" ? nextEvent() : nextEvent;
  };
  stripe.checkout.sessions.create = async (params) => ({
    id: `cs_test_created_${Math.random().toString(36).slice(2)}`,
    url: "https://checkout.stripe.com/c/pay/x",
    metadata: params.metadata,
  });
  stripe.checkout.sessions.retrieve = async (id) => {
    const session = sessionsById.get(id);
    if (!session) {
      const error = new Error(`No such checkout.session: ${id}`);
      error.type = "StripeInvalidRequestError";
      throw error;
    }
    return structuredClone(session);
  };
  stripe.checkout.sessions.list = async ({ payment_intent }) => ({
    data: [...sessionsById.values()].filter((session) => {
      const pi = session.payment_intent;
      return (typeof pi === "string" ? pi : pi?.id) === payment_intent;
    }),
  });
  stripe.paymentIntents.retrieve = async (id) => {
    const pi = paymentIntentsById.get(id);
    if (!pi) throw new Error(`No such payment_intent: ${id}`);
    return structuredClone(pi);
  };
}

function event(id, type, object) {
  return { id, type, data: { object } };
}

async function trackedSession({
  deviceId,
  sessionId,
  packId = "STARTER",
  status = "open",
  paymentStatus = "unpaid",
  paymentIntent = null,
}) {
  await recordCheckoutSessionCreated({
    checkoutSessionId: sessionId,
    deviceId,
    kind: "credits",
    packId,
    creditsDelta: packs[packId].credits,
  });
  const session = {
    id: sessionId,
    object: "checkout.session",
    status,
    payment_status: paymentStatus,
    payment_intent: paymentIntent,
    mode: "payment",
    amount_total: packs[packId].usd * 100,
    currency: "usd",
    created: Math.floor(Date.now() / 1000) - 3600,
    metadata: { deviceId, packId },
  };
  sessionsById.set(sessionId, session);
  return session;
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
  nextEvent = null;
  sessionsById = new Map();
  paymentIntentsById = new Map();
  sentAlerts = [];
  globalThis.fetch = async (url, init = {}) => {
    sentAlerts.push(JSON.parse(String(init.body || "{}")));
    return new Response("", { status: 202 });
  };
  delete env.CHECKOUT_UNFULFILLED_ALERT_MINUTES;
  stubStripe();
});

test.after(() => {
  globalThis.fetch = originalFetch;
});

const subjects = () =>
  sentAlerts.map((alert) => alert.personalizations?.[0]?.subject ?? "");

test("adaptive pricing is off for any Korean signal (request country, client country, locale)", async () => {
  const deviceId = "c0000000-0000-4000-8000-000000000001";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const created = [];
  stripe.checkout.sessions.create = async (params) => {
    created.push(params);
    return {
      id: `cs_test_ap_${created.length}`,
      url: "https://checkout.stripe.com/c/pay/x",
      metadata: params.metadata,
    };
  };
  const call = (route, ipCountry, body) =>
    apiRequest(route, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        ...(ipCountry ? { "CF-IPCountry": ipCountry } : {}),
      },
      body: JSON.stringify({ deviceId, ...body }),
    });

  assert.equal((await call("/payments/create-session", "BR", { packId: "MICRO", locale: "pt-BR" })).status, 200);
  assert.equal((await call("/payments/create-session", "TH", { packId: "MICRO", locale: "ko", country: "KR" })).status, 200);
  assert.equal((await call("/payments/create-byo-unlock", "KR", { locale: "en", country: "US" })).status, 200);
  assert.equal((await call("/payments/create-byo-unlock", "IN", { locale: "en" })).status, 200);

  assert.deepEqual(
    created.map((params) => params.adaptive_pricing),
    [{ enabled: true }, { enabled: false }, { enabled: false }, { enabled: true }],
  );
  // Still USD price IDs: Stripe converts at checkout, USD stays the base.
  assert.equal(created[0].line_items[0].price, packs.MICRO.priceId);
  assert.equal(created[3].line_items[0].price, env.STRIPE_BYO_UNLOCK_PRICE_ID);
});

test("completed+unpaid waits; async_payment_succeeded fulfils exactly once", async () => {
  const deviceId = "c0000000-0000-4000-8000-000000000002";
  const session = await trackedSession({
    deviceId,
    sessionId: "cs_test_async",
    status: "complete",
    paymentStatus: "unpaid",
    paymentIntent: "pi_test_async",
  });

  nextEvent = event("evt_completed_unpaid", "checkout.session.completed", session);
  assert.equal((await postWebhook()).status, 200);
  assert.equal(balance(deviceId), 0);
  assert.equal(row("cs_test_async").status, "created");

  const paid = { ...session, payment_status: "paid" };
  sessionsById.set(session.id, paid);
  nextEvent = event("evt_async_ok", "checkout.session.async_payment_succeeded", paid);
  assert.equal((await postWebhook()).status, 200);
  nextEvent = event("evt_pi_ok", "payment_intent.succeeded", {
    id: "pi_test_async",
    object: "payment_intent",
    status: "succeeded",
    amount_received: 500,
    currency: "usd",
    metadata: { deviceId, packId: "STARTER" },
  });
  assert.equal((await postWebhook()).status, 200);

  assert.equal(balance(deviceId), packs.STARTER.credits);
  assert.equal(grants(deviceId), 1);
  assert.equal(row("cs_test_async").status, "fulfilled");
});

test("async_payment_failed records failed with the decline reason and alerts", async () => {
  const deviceId = "c0000000-0000-4000-8000-000000000003";
  const session = await trackedSession({
    deviceId,
    sessionId: "cs_test_async_fail",
    status: "complete",
    paymentStatus: "unpaid",
    paymentIntent: "pi_test_async_fail",
  });
  paymentIntentsById.set("pi_test_async_fail", {
    id: "pi_test_async_fail",
    last_payment_error: {
      code: "payment_intent_payment_attempt_expired",
      message: "The customer did not pay the Pix QR code in time.",
      payment_method: { type: "pix" },
    },
  });
  nextEvent = event("evt_async_fail", "checkout.session.async_payment_failed", session);
  assert.equal((await postWebhook()).status, 200);

  const after = row("cs_test_async_fail");
  assert.equal(after.status, "failed");
  assert.match(after.error_message, /payment_intent_payment_attempt_expired/);
  assert.equal(after.last_payment_method_type, "pix");
  assert.equal(after.payment_attempt_failures, 1);
  assert.equal(balance(deviceId), 0);
  assert.ok(subjects().some((s) => /async checkout payment failed/.test(s)));
});

test("declines are recorded on the open session; expiry then cancels with that reason", async () => {
  const deviceId = "c0000000-0000-4000-8000-000000000004";
  await trackedSession({
    deviceId,
    sessionId: "cs_test_declined",
    paymentIntent: "pi_test_declined",
  });
  nextEvent = event("evt_pi_failed", "payment_intent.payment_failed", {
    id: "pi_test_declined",
    object: "payment_intent",
    status: "requires_payment_method",
    metadata: { deviceId, packId: "STARTER" },
    last_payment_error: {
      type: "card_error",
      code: "card_declined",
      decline_code: "generic_decline",
      message: "Your card was declined.",
      payment_method: { type: "card" },
    },
  });
  assert.equal((await postWebhook()).status, 200);

  let after = row("cs_test_declined");
  assert.equal(after.status, "created");
  assert.equal(after.last_payment_error_code, "card_declined");
  assert.equal(after.last_payment_decline_code, "generic_decline");
  assert.equal(after.last_payment_method_type, "card");
  assert.equal(after.payment_attempt_failures, 1);
  assert.ok(after.last_payment_error_at);
  assert.equal(sentAlerts.length, 0, "open-session declines stay recoverable, no email");

  nextEvent = event("evt_expired", "checkout.session.expired", {
    ...sessionsById.get("cs_test_declined"),
    status: "expired",
  });
  assert.equal((await postWebhook()).status, 200);
  after = row("cs_test_declined");
  assert.equal(after.status, "cancelled");
  assert.ok(after.expired_at);
  assert.equal(
    after.error_message,
    "expired after 1 failed payment attempt(s); last: generic_decline",
  );
  assert.equal(balance(deviceId), 0);
});

test("expiry without attempts cancels; other products on the shared account are ignored", async () => {
  const deviceId = "c0000000-0000-4000-8000-000000000005";
  await trackedSession({ deviceId, sessionId: "cs_test_left" });
  nextEvent = event("evt_expired_left", "checkout.session.expired", {
    id: "cs_test_left",
    status: "expired",
    metadata: { deviceId, packId: "STARTER" },
  });
  assert.equal((await postWebhook()).status, 200);
  assert.equal(row("cs_test_left").status, "cancelled");
  assert.equal(row("cs_test_left").error_message, "expired without a failed payment attempt");

  // Twinkle (same Stripe account) events: no Translator metadata, no row.
  nextEvent = event("evt_twinkle_expired", "checkout.session.expired", {
    id: "cs_test_twinkle",
    status: "expired",
    metadata: {},
  });
  assert.equal((await postWebhook()).status, 200);
  nextEvent = event("evt_twinkle_failed", "payment_intent.payment_failed", {
    id: "pi_test_twinkle",
    status: "requires_payment_method",
    metadata: { userId: "twinkle-user" },
    last_payment_error: { code: "card_declined" },
  });
  assert.equal((await postWebhook()).status, 200);
  nextEvent = event("evt_twinkle_async_fail", "checkout.session.async_payment_failed", {
    id: "cs_test_twinkle",
    status: "complete",
    payment_status: "unpaid",
    metadata: {},
  });
  assert.equal((await postWebhook()).status, 200);
  assert.equal(sentAlerts.length, 0);
});

test("status poll fulfils a paid session the webhook missed, once", async () => {
  const deviceId = "c0000000-0000-4000-8000-000000000006";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const session = await trackedSession({
    deviceId,
    sessionId: "cs_test_poll",
    status: "complete",
    paymentStatus: "paid",
    paymentIntent: "pi_test_poll",
  });

  for (let i = 0; i < 3; i += 1) {
    const response = await apiRequest("/payments/session/cs_test_poll", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.fulfillmentStatus, "fulfilled");
    assert.equal(body.balanceAfter, packs.STARTER.credits);
  }
  assert.equal(balance(deviceId), packs.STARTER.credits);
  assert.equal(grants(deviceId), 1);
  assert.equal(row("cs_test_poll").stripe_event_type, "backstop.session_poll");

  // The late webhook is a duplicate and proves delivery.
  nextEvent = event("evt_late", "checkout.session.completed", session);
  assert.equal((await postWebhook()).status, 200);
  assert.equal(grants(deviceId), 1);
  assert.equal(row("cs_test_poll").stripe_event_type, "checkout.session.completed");
});

test("status poll records an expired session as cancelled", async () => {
  const deviceId = "c0000000-0000-4000-8000-000000000007";
  const apiToken = await registerDeviceApiToken({ deviceId });
  await trackedSession({ deviceId, sessionId: "cs_test_poll_expired", status: "expired" });
  const response = await apiRequest("/payments/session/cs_test_poll_expired", {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal((await response.json()).fulfillmentStatus, "cancelled");
  assert.ok(row("cs_test_poll_expired").expired_at);
});

test("concurrent webhooks, status polls and sweep grant one pack", async () => {
  const deviceId = "c0000000-0000-4000-8000-000000000008";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const session = await trackedSession({
    deviceId,
    sessionId: "cs_test_race",
    packId: "PRO",
    status: "complete",
    paymentStatus: "paid",
    paymentIntent: "pi_test_race",
  });
  const events = [
    event("evt_race_completed", "checkout.session.completed", session),
    event("evt_race_pi", "payment_intent.succeeded", {
      id: "pi_test_race",
      status: "succeeded",
      amount_received: 5000,
      currency: "usd",
      metadata: { deviceId, packId: "PRO" },
    }),
  ];
  let eventIndex = 0;
  nextEvent = () => events[eventIndex++ % events.length];
  const poll = () =>
    apiRequest("/payments/session/cs_test_race", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

  const responses = await Promise.all([
    postWebhook(),
    poll(),
    postWebhook(),
    poll(),
    runCheckoutSweep(env),
  ]);
  for (const response of responses.slice(0, 4)) {
    assert.equal(response.status, 200);
  }
  assert.equal(balance(deviceId), packs.PRO.credits);
  assert.equal(grants(deviceId), 1);
  assert.equal(
    Number(scalar("SELECT COUNT(*) FROM stripe_fulfillments WHERE device_id = ?", [deviceId])),
    1,
  );
  assert.equal(row("cs_test_race").status, "fulfilled");
});

test("sweep fulfils paid-but-missed sessions, alerts after N minutes, expires stale ones", async () => {
  env.CHECKOUT_UNFULFILLED_ALERT_MINUTES = "10";
  const deviceId = "c0000000-0000-4000-8000-000000000009";
  const nowSec = Math.floor(Date.now() / 1000);
  const paidLong = await trackedSession({
    deviceId,
    sessionId: "cs_test_sweep_old",
    status: "complete",
    paymentStatus: "paid",
  });
  paidLong.payment_intent = { id: "pi_test_sweep_old", created: nowSec - 30 * 60 };
  const paidJust = await trackedSession({
    deviceId,
    sessionId: "cs_test_sweep_new",
    packId: "MICRO",
    status: "complete",
    paymentStatus: "paid",
  });
  paidJust.payment_intent = { id: "pi_test_sweep_new", created: nowSec - 60 };
  await trackedSession({ deviceId, sessionId: "cs_test_sweep_expired", status: "expired" });
  await trackedSession({ deviceId, sessionId: "cs_test_sweep_open", status: "open" });
  // Outside the 48 h window: never touched.
  await trackedSession({ deviceId, sessionId: "cs_test_sweep_ancient", status: "complete", paymentStatus: "paid" });
  sqlite
    .prepare("UPDATE checkout_sessions SET created_at = datetime('now', '-3 days') WHERE checkout_session_id = ?")
    .run("cs_test_sweep_ancient");

  const report = await runCheckoutSweep(env);
  assert.equal(report.scanned, 4);
  assert.equal(report.fulfilled, 2);
  assert.equal(report.expired, 1);
  assert.equal(report.alerted, 1);
  assert.deepEqual(report.errors, []);
  assert.equal(balance(deviceId), packs.STARTER.credits + packs.MICRO.credits);
  assert.equal(row("cs_test_sweep_old").stripe_event_type, "backstop.checkout_sweep");
  assert.equal(row("cs_test_sweep_expired").status, "cancelled");
  assert.equal(row("cs_test_sweep_open").status, "created");
  assert.equal(row("cs_test_sweep_ancient").status, "created");
  assert.equal(subjects().length, 1);
  assert.match(subjects()[0], /not fulfilled after 10 minutes/);
  assert.match(sentAlerts[0].content[0].value, /cs_test_sweep_old/);

  const again = await runCheckoutSweep(env);
  assert.equal(again.fulfilled, 0);
  assert.equal(again.alerted, 0);
  assert.equal(grants(deviceId), 2);
});

test("sweep alerts once when the poll had to fulfil and no webhook ever followed", async () => {
  const deviceId = "c0000000-0000-4000-8000-00000000000a";
  const apiToken = await registerDeviceApiToken({ deviceId });
  await trackedSession({
    deviceId,
    sessionId: "cs_test_no_webhook",
    status: "complete",
    paymentStatus: "paid",
    paymentIntent: "pi_test_no_webhook",
  });
  await apiRequest("/payments/session/cs_test_no_webhook", {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  assert.equal((await runCheckoutSweep(env)).alerted, 0, "too early to call it missing");
  sqlite
    .prepare("UPDATE checkout_sessions SET fulfilled_at = datetime('now', '-30 minutes') WHERE checkout_session_id = ?")
    .run("cs_test_no_webhook");
  assert.equal((await runCheckoutSweep(env)).alerted, 1);
  assert.equal((await runCheckoutSweep(env)).alerted, 0);
  assert.match(subjects()[0], /webhook never arrived/);
});

test("webhook processing errors return 500 and alert once per event", async () => {
  const deviceId = "c0000000-0000-4000-8000-00000000000b";
  const session = await trackedSession({
    deviceId,
    sessionId: "cs_test_db_down",
    status: "complete",
    paymentStatus: "paid",
    paymentIntent: "pi_test_db_down",
  });
  sqlite.exec("ALTER TABLE stripe_fulfillments RENAME TO stripe_fulfillments_offline");
  nextEvent = event("evt_db_down", "checkout.session.completed", session);
  assert.equal((await postWebhook()).status, 500);
  assert.equal((await postWebhook()).status, 500);
  assert.equal(subjects().filter((s) => /webhook processing failed/.test(s)).length, 1);
  assert.match(sentAlerts[0].content[0].value, /evt_db_down/);

  // Stripe's retry after recovery fulfils once.
  sqlite.exec("ALTER TABLE stripe_fulfillments_offline RENAME TO stripe_fulfillments");
  assert.equal((await postWebhook()).status, 200);
  assert.equal(grants(deviceId), 1);
});

test("signature failures return 400 and alert at most once an hour", async () => {
  nextEvent = null;
  assert.equal((await postWebhook()).status, 400);
  assert.equal((await postWebhook()).status, 400);
  assert.equal(subjects().filter((s) => /signature verification failed/.test(s)).length, 1);
});
