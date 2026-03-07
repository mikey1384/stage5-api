import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { registerDeviceApiToken } from "../src/lib/db/api-tokens.ts";
import { fulfillByoOpenAiUnlock } from "../src/lib/db/payments.ts";
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
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

function authHeaders(apiToken, extra = {}) {
  return {
    Authorization: `Bearer ${apiToken}`,
    ...extra,
  };
}

async function apiRequest(path, init = {}) {
  const request = new Request(`http://localhost${path}`, init);
  return worker.fetch(request, env, ctx);
}

function count(sql, params = []) {
  const row = sqlite.prepare(sql).get(...params);
  return Number(row?.count ?? 0);
}

function configureStripeStubs({
  createSession,
  retrieveSession,
  constructEvent,
} = {}) {
  const stripe = getStripe(env.STRIPE_SECRET_KEY);
  stripe.checkout.sessions.create =
    createSession ??
    (async () => ({
      id: "cs_test_default",
      url: "https://checkout.stripe.com/c/pay/cs_test_default",
    }));
  stripe.checkout.sessions.retrieve =
    retrieveSession ??
    (async (sessionId) => ({
      id: sessionId,
      status: "open",
      payment_status: "unpaid",
      mode: "payment",
      metadata: {},
      created: 1_700_000_000,
    }));
  stripe.webhooks.constructEventAsync =
    constructEvent ??
    (async () => {
      throw new Error("constructEventAsync stub not set for this test");
    });
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
  configureStripeStubs();
});

test("credit pack fulfillment stays exact-once across mixed Stripe event types", async () => {
  const deviceId = "11111111-1111-4111-8111-111111111111";
  const paymentIntentId = "pi_test_credit";
  const sessionId = "cs_test_credit";
  const events = [
    {
      id: "evt_payment_intent_credit",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: paymentIntentId,
          status: "succeeded",
          metadata: {
            deviceId,
            packId: "MICRO",
          },
        },
      },
    },
    {
      id: "evt_checkout_credit",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          payment_status: "paid",
          payment_intent: paymentIntentId,
          metadata: {
            deviceId,
            packId: "MICRO",
          },
        },
      },
    },
  ];
  let eventIndex = 0;

  configureStripeStubs({
    constructEvent: async () => events[eventIndex++],
  });

  const first = await apiRequest("/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": "sig_test_credit_1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ok: true }),
  });
  const second = await apiRequest("/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": "sig_test_credit_2",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ok: true }),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(
    sqlite
      .prepare("SELECT credit_balance FROM credits WHERE device_id = ?")
      .get(deviceId)?.credit_balance,
    packs.MICRO.credits
  );
  assert.equal(
    count("SELECT COUNT(*) AS count FROM credit_ledger WHERE device_id = ?", [
      deviceId,
    ]),
    1
  );
  assert.equal(
    count(
      "SELECT COUNT(*) AS count FROM stripe_fulfillments WHERE device_id = ? AND fulfillment_kind = 'credits'",
      [deviceId]
    ),
    1
  );
  assert.equal(
    count("SELECT COUNT(*) AS count FROM processed_events"),
    2
  );
});

test("BYO unlock fulfillment stays exact-once across mixed Stripe event types", async () => {
  const deviceId = "22222222-2222-4222-8222-222222222222";
  const paymentIntentId = "pi_test_byo";
  const sessionId = "cs_test_byo";
  const events = [
    {
      id: "evt_payment_intent_byo",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: paymentIntentId,
          status: "succeeded",
          metadata: {
            deviceId,
            entitlement: "byo_openai",
          },
        },
      },
    },
    {
      id: "evt_checkout_byo",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          payment_status: "paid",
          payment_intent: paymentIntentId,
          metadata: {
            deviceId,
            entitlement: "byo_openai",
          },
        },
      },
    },
  ];
  let eventIndex = 0;

  configureStripeStubs({
    constructEvent: async () => events[eventIndex++],
  });

  const first = await apiRequest("/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": "sig_test_byo_1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ok: true }),
  });
  const second = await apiRequest("/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": "sig_test_byo_2",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ok: true }),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const entitlementRow = sqlite
    .prepare(
      "SELECT byo_openai, byo_anthropic FROM entitlements WHERE device_id = ?"
    )
    .get(deviceId);
  assert.equal(entitlementRow?.byo_openai, 1);
  assert.equal(entitlementRow?.byo_anthropic, 1);
  assert.equal(
    count(
      "SELECT COUNT(*) AS count FROM stripe_fulfillments WHERE device_id = ? AND fulfillment_kind = 'entitlement'",
      [deviceId]
    ),
    1
  );
});

test("fresh device with opaque token can create payment sessions and poll settlement without a credits row", async () => {
  const deviceId = "33333333-3333-4333-8333-333333333333";
  const apiToken = await registerDeviceApiToken({ deviceId });
  let createdCount = 0;
  const createdParams = [];

  configureStripeStubs({
    createSession: async (params) => {
      createdCount += 1;
      createdParams.push(params);
      return {
        id: createdCount === 1 ? "cs_test_pack" : "cs_test_byo_create",
        url: `https://checkout.stripe.com/c/pay/${createdCount}`,
        metadata: params.metadata,
      };
    },
    retrieveSession: async (sessionId) => ({
      id: sessionId,
      status: "open",
      payment_status: "unpaid",
      mode: "payment",
      metadata: {
        deviceId,
        packId: "MICRO",
      },
      created: 1_700_000_001,
    }),
  });

  const createPack = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId,
      packId: "MICRO",
      locale: "en",
    }),
  });
  assert.equal(createPack.status, 200);
  assert.equal((await createPack.json()).sessionId, "cs_test_pack");

  const createByo = await apiRequest("/payments/create-byo-unlock", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId,
      locale: "en",
    }),
  });
  assert.equal(createByo.status, 200);
  assert.equal((await createByo.json()).sessionId, "cs_test_byo_create");
  assert.equal(createdParams[0]?.metadata?.deviceId, deviceId);
  assert.equal(createdParams[0]?.metadata?.packId, "MICRO");
  assert.equal(
    createdParams[1]?.success_url,
    "https://translator.tools/checkout/success?mode=byo&session_id={CHECKOUT_SESSION_ID}"
  );
  assert.equal(
    createdParams[1]?.cancel_url,
    "https://translator.tools/checkout/cancelled?mode=byo"
  );

  const settlement = await apiRequest("/payments/session/cs_test_pack", {
    headers: authHeaders(apiToken),
  });
  assert.equal(settlement.status, 200);
  const settlementJson = await settlement.json();
  assert.equal(settlementJson.sessionId, "cs_test_pack");
  assert.equal(settlementJson.packId, "MICRO");
  assert.equal(
    count("SELECT COUNT(*) AS count FROM credits WHERE device_id = ?", [deviceId]),
    0
  );
});

test("checkout creation is bound to the authenticated device", async () => {
  const apiToken = await registerDeviceApiToken({
    deviceId: "55555555-5555-4555-8555-555555555555",
  });

  const response = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId: "66666666-6666-4666-8666-666666666666",
      packId: "MICRO",
      locale: "en",
    }),
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "Forbidden");
});

test("checkout polling refuses sessions owned by another device", async () => {
  const deviceId = "77777777-7777-4777-8777-777777777777";
  const apiToken = await registerDeviceApiToken({ deviceId });

  configureStripeStubs({
    retrieveSession: async (sessionId) => ({
      id: sessionId,
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      metadata: {
        deviceId: "88888888-8888-4888-8888-888888888888",
        packId: "MICRO",
      },
      created: 1_700_000_777,
    }),
  });

  const response = await apiRequest("/payments/session/cs_foreign_device", {
    headers: authHeaders(apiToken),
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "Forbidden");
});

test("fresh-device BYO unlock is readable through entitlements without a credits row", async () => {
  const deviceId = "44444444-4444-4444-8444-444444444444";
  const apiToken = await registerDeviceApiToken({ deviceId });

  const result = await fulfillByoOpenAiUnlock({
    deviceId,
    entitlement: "byo_openai",
    paymentIntentId: "pi_test_visible_byo",
    stripeEventType: "test.manual",
  });
  assert.equal(result, "applied");

  const response = await apiRequest(`/entitlements/${deviceId}`, {
    headers: authHeaders(apiToken),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.entitlements, {
    byoOpenAi: true,
    byoAnthropic: true,
    byoElevenLabs: true,
  });
  assert.equal(
    count("SELECT COUNT(*) AS count FROM credits WHERE device_id = ?", [deviceId]),
    0
  );
});
