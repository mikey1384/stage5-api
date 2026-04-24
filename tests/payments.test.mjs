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
  listSessions,
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
  stripe.checkout.sessions.list =
    listSessions ??
    (async () => ({
      data: [],
    }));
  stripe.webhooks.constructEventAsync =
    constructEvent ??
    (async () => {
      throw new Error("constructEventAsync stub not set for this test");
    });
}

async function withPaymentEventsStub(run) {
  const originalPaymentEvents = env.PAYMENT_EVENTS;
  const broadcasts = [];

  env.PAYMENT_EVENTS = {
    idFromName(name) {
      return name;
    },
    get(id) {
      return {
        async fetch(url, init = {}) {
          broadcasts.push({
            id,
            url: String(url),
            body: JSON.parse(String(init.body || "{}")),
          });
          return new Response("", { status: 200 });
        },
      };
    },
  };

  try {
    await run(broadcasts);
  } finally {
    if (originalPaymentEvents === undefined) {
      delete env.PAYMENT_EVENTS;
    } else {
      env.PAYMENT_EVENTS = originalPaymentEvents;
    }
  }
}

async function withPaymentAlertEmailStub(run) {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    SENDGRID_API_KEY: env.SENDGRID_API_KEY,
    PAYMENT_ALERT_EMAIL_TO: env.PAYMENT_ALERT_EMAIL_TO,
    PAYMENT_ALERT_EMAIL_FROM: env.PAYMENT_ALERT_EMAIL_FROM,
  };
  const sent = [];

  env.SENDGRID_API_KEY = "sendgrid-test-key";
  env.PAYMENT_ALERT_EMAIL_TO = "mikey@stage5.tools";
  env.PAYMENT_ALERT_EMAIL_FROM = "alerts@stage5.tools";
  globalThis.fetch = async (url, init = {}) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init.body || "{}")),
    });
    return new Response("", { status: 202 });
  };

  try {
    await run(sent);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }
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
  const createPackJson = await createPack.json();
  assert.equal(createPackJson.sessionId, "cs_test_pack");
  assert.match(createPackJson.returnId, /^[a-zA-Z0-9_-]{16,128}$/);
  const packCheckoutRow = sqlite
    .prepare(
      `SELECT kind, status, pack_id, credits_delta, checkout_return_id
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get("cs_test_pack");
  assert.deepEqual({ ...packCheckoutRow }, {
    kind: "credits",
    status: "created",
    pack_id: "MICRO",
    credits_delta: packs.MICRO.credits,
    checkout_return_id: createPackJson.returnId,
  });

  const packReturn = await apiRequest(
    `/payments/checkout-return/${encodeURIComponent(createPackJson.returnId)}`,
    {
      headers: authHeaders(apiToken),
    }
  );
  assert.equal(packReturn.status, 200);
  assert.deepEqual(await packReturn.json(), {
    sessionId: "cs_test_pack",
    mode: "credits",
    fulfillmentStatus: "created",
    packId: "MICRO",
    entitlement: null,
  });

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
  const createByoJson = await createByo.json();
  assert.equal(createByoJson.sessionId, "cs_test_byo_create");
  assert.match(createByoJson.returnId, /^[a-zA-Z0-9_-]{16,128}$/);
  const byoCheckoutRow = sqlite
    .prepare(
      `SELECT kind, status, entitlement, checkout_return_id
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get("cs_test_byo_create");
  assert.deepEqual({ ...byoCheckoutRow }, {
    kind: "entitlement",
    status: "created",
    entitlement: "byo_openai",
    checkout_return_id: createByoJson.returnId,
  });
  assert.equal(createdParams[0]?.metadata?.deviceId, deviceId);
  assert.equal(createdParams[0]?.metadata?.packId, "MICRO");
  const packCancelUrl = new URL(createdParams[0]?.cancel_url);
  assert.equal(packCancelUrl.pathname, "/checkout/cancelled");
  assert.ok(packCancelUrl.searchParams.get("return_id"));
  assert.equal(packCancelUrl.searchParams.has("session_id"), false);
  assert.equal("payment_method_types" in createdParams[0], false);
  assert.match(
    createdParams[1]?.success_url,
    /^https:\/\/translator\.tools\/checkout\/success\?mode=byo&return_id=[a-zA-Z0-9_-]+&session_id=\{CHECKOUT_SESSION_ID\}$/
  );
  const byoCancelUrl = new URL(createdParams[1]?.cancel_url);
  assert.equal(byoCancelUrl.pathname, "/checkout/cancelled");
  assert.equal(byoCancelUrl.searchParams.get("mode"), "byo");
  assert.ok(byoCancelUrl.searchParams.get("return_id"));
  assert.equal(byoCancelUrl.searchParams.has("session_id"), false);
  assert.equal("payment_method_types" in createdParams[1], false);

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

test("Korean credit checkout uses KRW with local payment methods", async () => {
  const deviceId = "44444444-4444-4444-8444-444444444444";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const createdParams = [];

  configureStripeStubs({
    createSession: async (params) => {
      createdParams.push(params);
      return {
        id: "cs_test_korean_pack",
        url: "https://checkout.stripe.com/c/pay/cs_test_korean_pack",
        metadata: params.metadata,
      };
    },
  });

  const response = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId,
      packId: "STANDARD",
      locale: "ko-KR",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, "cs_test_korean_pack");
  assert.deepEqual(createdParams[0]?.payment_method_types, [
    "card",
    "kr_card",
    "kakao_pay",
    "naver_pay",
  ]);
  assert.equal(createdParams[0]?.locale, "ko");
  assert.equal(createdParams[0]?.line_items?.[0]?.price, undefined);
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.currency,
    "krw"
  );
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.unit_amount,
    packs.STANDARD.krw
  );
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.product_data?.name,
    "STANDARD - 350,000 AI Credits"
  );
  assert.equal(createdParams[0]?.metadata?.packId, "STANDARD");
  assert.equal(createdParams[0]?.metadata?.deviceId, deviceId);
});

test("Korean checkout locale overrides non-KR country hints", async () => {
  const deviceId = "47474747-4747-4747-8747-474747474747";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const createdParams = [];

  configureStripeStubs({
    createSession: async (params) => {
      createdParams.push(params);
      return {
        id: "cs_test_korean_country_override",
        url: "https://checkout.stripe.com/c/pay/cs_test_korean_country_override",
        metadata: params.metadata,
      };
    },
  });

  const response = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
      "CF-IPCountry": "TH",
    }),
    body: JSON.stringify({
      deviceId,
      packId: "MICRO",
      locale: "ko-KR",
      country: "TH",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).sessionId,
    "cs_test_korean_country_override"
  );
  assert.deepEqual(createdParams[0]?.payment_method_types, [
    "card",
    "kr_card",
    "kakao_pay",
    "naver_pay",
  ]);
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.currency,
    "krw"
  );
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.unit_amount,
    packs.MICRO.krw
  );
});

test("request country overrides locale-derived country hint for Korean geo", async () => {
  const deviceId = "48484848-4848-4848-8848-484848484848";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const createdParams = [];

  configureStripeStubs({
    createSession: async (params) => {
      createdParams.push(params);
      return {
        id: "cs_test_korean_geo_override",
        url: "https://checkout.stripe.com/c/pay/cs_test_korean_geo_override",
        metadata: params.metadata,
      };
    },
  });

  const response = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
      "CF-IPCountry": "KR",
    }),
    body: JSON.stringify({
      deviceId,
      packId: "MICRO",
      locale: "en-US",
      country: "US",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, "cs_test_korean_geo_override");
  assert.deepEqual(createdParams[0]?.payment_method_types, [
    "card",
    "kr_card",
    "kakao_pay",
    "naver_pay",
  ]);
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.currency,
    "krw"
  );
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.unit_amount,
    packs.MICRO.krw
  );
});

test("Korean BYO checkout uses KRW with local payment methods", async () => {
  const deviceId = "49494949-4949-4949-8949-494949494949";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const createdParams = [];

  configureStripeStubs({
    createSession: async (params) => {
      createdParams.push(params);
      return {
        id: "cs_test_korean_byo",
        url: "https://checkout.stripe.com/c/pay/cs_test_korean_byo",
        metadata: params.metadata,
      };
    },
  });

  const response = await apiRequest("/payments/create-byo-unlock", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId,
      locale: "ko-KR",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, "cs_test_korean_byo");
  assert.deepEqual(createdParams[0]?.payment_method_types, [
    "card",
    "kr_card",
    "kakao_pay",
    "naver_pay",
  ]);
  assert.equal(createdParams[0]?.locale, "ko");
  assert.equal(createdParams[0]?.line_items?.[0]?.price, undefined);
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.currency,
    "krw"
  );
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.unit_amount,
    15_422
  );
  assert.equal(
    createdParams[0]?.line_items?.[0]?.price_data?.product_data?.name,
    "BYO API Keys Unlock"
  );
  assert.equal(createdParams[0]?.metadata?.entitlement, "byo_openai");
  assert.equal(createdParams[0]?.metadata?.deviceId, deviceId);
});

test("checkout webhook writes authoritative fulfilled balance to checkout session", async () => {
  const deviceId = "bbbbbbbb-0000-4000-8000-000000000001";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const sessionId = "cs_test_authoritative_balance";
  const paymentIntentId = "pi_test_authoritative_balance";

  configureStripeStubs({
    createSession: async params => ({
      id: sessionId,
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
      metadata: params.metadata,
    }),
    constructEvent: async () => ({
      id: "evt_authoritative_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          payment_status: "paid",
          payment_intent: paymentIntentId,
          metadata: {
            deviceId,
            packId: "STARTER",
          },
        },
      },
    }),
  });

  const createResponse = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId,
      packId: "STARTER",
      locale: "en",
    }),
  });
  assert.equal(createResponse.status, 200);

  const webhookResponse = await apiRequest("/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": "sig_authoritative_checkout",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(webhookResponse.status, 200);

  const checkoutRow = sqlite
    .prepare(
      `SELECT status, payment_intent_id, stripe_event_id, stripe_event_type, credit_balance_after
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get(sessionId);
  assert.deepEqual({ ...checkoutRow }, {
    status: "fulfilled",
    payment_intent_id: paymentIntentId,
    stripe_event_id: "evt_authoritative_checkout",
    stripe_event_type: "checkout.session.completed",
    credit_balance_after: packs.STARTER.credits,
  });
});

test("payment intent success marks the resolved checkout session fulfilled", async () => {
  const deviceId = "bbbbbbbb-0000-4000-8000-000000000002";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const sessionId = "cs_test_payment_intent_checkout_link";
  const paymentIntentId = "pi_test_payment_intent_checkout_link";

  configureStripeStubs({
    createSession: async params => ({
      id: sessionId,
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
      metadata: params.metadata,
    }),
    listSessions: async params => {
      assert.deepEqual(params, {
        payment_intent: paymentIntentId,
        limit: 1,
      });
      return {
        data: [
          {
            id: sessionId,
            status: "complete",
            payment_intent: paymentIntentId,
            metadata: {
              deviceId,
              packId: "STARTER",
            },
          },
        ],
      };
    },
    constructEvent: async () => ({
      id: "evt_payment_intent_checkout_link",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: paymentIntentId,
          status: "succeeded",
          metadata: {
            deviceId,
            packId: "STARTER",
          },
        },
      },
    }),
  });

  const createResponse = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId,
      packId: "STARTER",
      locale: "en",
    }),
  });
  assert.equal(createResponse.status, 200);

  await withPaymentEventsStub(async broadcasts => {
    const webhookResponse = await apiRequest("/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": "sig_payment_intent_checkout_link",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(webhookResponse.status, 200);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].body.type, "credits.updated");
    assert.equal(broadcasts[0].body.checkoutSessionId, sessionId);
  });

  const checkoutRow = sqlite
    .prepare(
      `SELECT status, payment_intent_id, stripe_event_id, stripe_event_type, credit_balance_after
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get(sessionId);
  assert.deepEqual({ ...checkoutRow }, {
    status: "fulfilled",
    payment_intent_id: paymentIntentId,
    stripe_event_id: "evt_payment_intent_checkout_link",
    stripe_event_type: "payment_intent.succeeded",
    credit_balance_after: packs.STARTER.credits,
  });
});

test("late payment intent failures do not downgrade fulfilled checkout sessions", async () => {
  const deviceId = "bbbbbbbb-0000-4000-8000-000000000003";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const sessionId = "cs_test_late_payment_failure_after_success";
  const successPaymentIntentId = "pi_late_failure_success";
  const failedPaymentIntentId = "pi_late_failure_old_attempt";
  let webhookCall = 0;

  configureStripeStubs({
    createSession: async params => ({
      id: sessionId,
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
      metadata: params.metadata,
    }),
    listSessions: async params => {
      assert.equal(params.limit, 1);
      assert.ok(
        params.payment_intent === successPaymentIntentId ||
          params.payment_intent === failedPaymentIntentId
      );
      return {
        data: [
          {
            id: sessionId,
            status: "complete",
            payment_status: "paid",
            payment_intent: params.payment_intent,
            metadata: {
              deviceId,
              packId: "STARTER",
            },
          },
        ],
      };
    },
    constructEvent: async () => {
      const event =
        webhookCall === 0
          ? {
              id: "evt_late_failure_success",
              type: "payment_intent.succeeded",
              data: {
                object: {
                  id: successPaymentIntentId,
                  status: "succeeded",
                  metadata: {
                    deviceId,
                    packId: "STARTER",
                  },
                },
              },
            }
          : {
              id: "evt_late_failure_old_attempt",
              type: "payment_intent.payment_failed",
              data: {
                object: {
                  id: failedPaymentIntentId,
                  status: "requires_payment_method",
                  metadata: {
                    deviceId,
                    packId: "STARTER",
                  },
                  last_payment_error: {
                    message: "Your card was declined.",
                  },
                },
              },
            };
      webhookCall += 1;
      return event;
    },
  });

  const createResponse = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId,
      packId: "STARTER",
      locale: "en",
    }),
  });
  assert.equal(createResponse.status, 200);

  await withPaymentEventsStub(async broadcasts => {
    const successWebhookResponse = await apiRequest("/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": "sig_late_failure_success",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(successWebhookResponse.status, 200);

    const failureWebhookResponse = await apiRequest("/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": "sig_late_failure_old_attempt",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(failureWebhookResponse.status, 200);

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].body.type, "credits.updated");
    assert.equal(broadcasts[0].body.checkoutSessionId, sessionId);
  });

  const checkoutRow = sqlite
    .prepare(
      `SELECT status, payment_intent_id, stripe_event_id, stripe_event_type, credit_balance_after
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get(sessionId);
  assert.deepEqual({ ...checkoutRow }, {
    status: "fulfilled",
    payment_intent_id: successPaymentIntentId,
    stripe_event_id: "evt_late_failure_success",
    stripe_event_type: "payment_intent.succeeded",
    credit_balance_after: packs.STARTER.credits,
  });
});

test("malformed checkout creation JSON does not send payment alert email", async () => {
  await withPaymentAlertEmailStub(async (sent) => {
    for (const path of [
      "/payments/create-session",
      "/payments/create-byo-unlock",
    ]) {
      const response = await apiRequest(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      });

      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "Invalid JSON body");
    }

    assert.equal(sent.length, 0);
  });
});

test("client checkout failure events send payment alert email", async () => {
  const deviceId = "99999999-9999-4999-8999-999999999999";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const sessionId = "cs_client_cancel";

  configureStripeStubs({
    createSession: async params => ({
      id: sessionId,
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
      metadata: params.metadata,
    }),
    retrieveSession: async (sessionId) => ({
      id: sessionId,
      status: "open",
      payment_status: "unpaid",
      mode: "payment",
      amount_total: 5000,
      currency: "usd",
      metadata: {
        deviceId,
        packId: "PRO",
      },
      payment_intent: "pi_checkout_client_event",
      created: 1_700_001_111,
    }),
  });

  const createResponse = await apiRequest("/payments/create-session", {
    method: "POST",
    headers: authHeaders(apiToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      deviceId,
      packId: "PRO",
      locale: "en",
    }),
  });
  assert.equal(createResponse.status, 200);
  assert.equal((await createResponse.json()).sessionId, sessionId);

  await withPaymentAlertEmailStub(async (sent) => {
    const eventBody = {
      sessionId,
      eventType: "embedded_cancel_redirect",
      mode: "credits",
      packId: "PRO",
    };
    const headers = authHeaders(apiToken, {
      "content-type": "application/json",
      "X-Stage5-App-Version": "1.13.22",
    });
    const response = await apiRequest("/payments/checkout-event", {
      method: "POST",
      headers,
      body: JSON.stringify(eventBody),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const replay = await apiRequest("/payments/checkout-event", {
      method: "POST",
      headers,
      body: JSON.stringify(eventBody),
    });

    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: true, duplicate: true });
    assert.equal(sent.length, 1);
    assert.match(
      sent[0].body.personalizations[0].subject,
      /embedded_cancel_redirect/
    );
    assert.match(sent[0].body.content[0].value, /cs_client_cancel/);
    assert.match(sent[0].body.content[0].value, /1\.13\.22/);
  });

  const checkoutRow = sqlite
    .prepare(
      `SELECT status, stripe_event_id, stripe_event_type, error_message
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get(sessionId);
  assert.deepEqual({ ...checkoutRow }, {
    status: "cancelled",
    stripe_event_id:
      "checkout-client-event:cs_client_cancel:embedded_cancel_redirect",
    stripe_event_type: "checkout_client.embedded_cancel_redirect",
    error_message: "Translator reported embedded_cancel_redirect",
  });

  const pollResponse = await apiRequest(`/payments/session/${sessionId}`, {
    method: "GET",
    headers: authHeaders(apiToken),
  });
  assert.equal(pollResponse.status, 200);
  assert.equal((await pollResponse.json()).fulfillmentStatus, "cancelled");
});

test("Stripe payment failures send payment alert email", async () => {
  const deviceId = "aaaaaaaa-0000-4000-8000-000000000001";

  configureStripeStubs({
    constructEvent: async () => ({
      id: "evt_payment_failed_alert",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_payment_failed_alert",
          status: "requires_payment_method",
          amount: 5000,
          currency: "usd",
          metadata: {
            deviceId,
            packId: "PRO",
          },
          last_payment_error: {
            type: "card_error",
            code: "card_declined",
            decline_code: "authentication_required",
            message: "The card requires authentication.",
            payment_method: {
              type: "card",
            },
          },
        },
      },
    }),
  });

  await withPaymentAlertEmailStub(async (sent) => {
    const response = await apiRequest("/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": "sig_payment_failed_alert",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    });

    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    assert.match(
      sent[0].body.personalizations[0].subject,
      /payment intent failed/
    );
    assert.match(sent[0].body.content[0].value, /pi_payment_failed_alert/);
    assert.match(sent[0].body.content[0].value, /authentication_required/);
  });
});

test("Stripe payment failures broadcast checkout failure to the device", async () => {
  const deviceId = "aaaaaaaa-0000-4000-8000-000000000002";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const sessionId = "cs_test_payment_failed_broadcast";
  const paymentIntentId = "pi_payment_failed_broadcast";

  configureStripeStubs({
    createSession: async params => ({
      id: sessionId,
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
      metadata: params.metadata,
    }),
    listSessions: async params => {
      assert.deepEqual(params, {
        payment_intent: paymentIntentId,
        limit: 1,
      });
      return {
        data: [
          {
            id: sessionId,
            status: "expired",
            payment_intent: paymentIntentId,
            metadata: {
              deviceId,
              packId: "MICRO",
            },
          },
        ],
      };
    },
    constructEvent: async () => ({
      id: "evt_payment_failed_broadcast",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: paymentIntentId,
          status: "requires_payment_method",
          metadata: {
            deviceId,
            packId: "MICRO",
          },
          last_payment_error: {
            message: "Your card was declined.",
          },
        },
      },
    }),
  });

  const createResponse = await apiRequest("/payments/create-session", {
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
  assert.equal(createResponse.status, 200);

  await withPaymentAlertEmailStub(async () => {
    await withPaymentEventsStub(async broadcasts => {
      const response = await apiRequest("/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "sig_payment_failed_broadcast",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ok: true }),
      });

      assert.equal(response.status, 200);
      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0].id, deviceId);
      assert.deepEqual(broadcasts[0].body, {
        type: "checkout.failed",
        source: "stripe_webhook",
        deviceId,
        checkoutSessionId: sessionId,
        paymentIntentId,
        mode: "credits",
        packId: "MICRO",
        entitlement: null,
        message: "Your card was declined.",
        stripeEventId: "evt_payment_failed_broadcast",
        stripeEventType: "payment_intent.payment_failed",
      });
    });
  });

  const checkoutRow = sqlite
    .prepare(
      `SELECT status, payment_intent_id, stripe_event_id, stripe_event_type, error_message
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get(sessionId);
  assert.deepEqual({ ...checkoutRow }, {
    status: "failed",
    payment_intent_id: paymentIntentId,
    stripe_event_id: "evt_payment_failed_broadcast",
    stripe_event_type: "payment_intent.payment_failed",
    error_message: "Your card was declined.",
  });
});

test("Stripe payment failures keep open checkout sessions recoverable", async () => {
  const deviceId = "aaaaaaaa-0000-4000-8000-000000000003";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const sessionId = "cs_test_payment_failed_open";
  const paymentIntentId = "pi_payment_failed_open";

  configureStripeStubs({
    createSession: async params => ({
      id: sessionId,
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
      metadata: params.metadata,
    }),
    listSessions: async params => {
      assert.deepEqual(params, {
        payment_intent: paymentIntentId,
        limit: 1,
      });
      return {
        data: [
          {
            id: sessionId,
            status: "open",
            payment_intent: paymentIntentId,
            metadata: {
              deviceId,
              packId: "MICRO",
            },
          },
        ],
      };
    },
    constructEvent: async () => ({
      id: "evt_payment_failed_open",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: paymentIntentId,
          status: "requires_payment_method",
          metadata: {
            deviceId,
            packId: "MICRO",
          },
          last_payment_error: {
            message: "Your card was declined.",
          },
        },
      },
    }),
  });

  const createResponse = await apiRequest("/payments/create-session", {
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
  assert.equal(createResponse.status, 200);

  await withPaymentAlertEmailStub(async sent => {
    await withPaymentEventsStub(async broadcasts => {
      const response = await apiRequest("/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "sig_payment_failed_open",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ok: true }),
      });

      assert.equal(response.status, 200);
      assert.equal(sent.length, 0);
      assert.equal(broadcasts.length, 0);
    });
  });

  const checkoutRow = sqlite
    .prepare(
      `SELECT status, payment_intent_id, stripe_event_id, stripe_event_type, error_message
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get(sessionId);
  assert.deepEqual({ ...checkoutRow }, {
    status: "created",
    payment_intent_id: null,
    stripe_event_id: null,
    stripe_event_type: null,
    error_message: null,
  });
});

test("Stripe payment failures with inconclusive session lookup do not cancel checkout", async () => {
  const deviceId = "aaaaaaaa-0000-4000-8000-000000000004";
  const apiToken = await registerDeviceApiToken({ deviceId });
  const sessionId = "cs_test_payment_failed_lookup_error";
  const paymentIntentId = "pi_payment_failed_lookup_error";

  configureStripeStubs({
    createSession: async params => ({
      id: sessionId,
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
      metadata: params.metadata,
    }),
    listSessions: async params => {
      assert.deepEqual(params, {
        payment_intent: paymentIntentId,
        limit: 1,
      });
      throw new Error("temporary Stripe lookup failure");
    },
    constructEvent: async () => ({
      id: "evt_payment_failed_lookup_error",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: paymentIntentId,
          status: "requires_payment_method",
          metadata: {
            deviceId,
            packId: "MICRO",
          },
          last_payment_error: {
            message: "Your card was declined.",
          },
        },
      },
    }),
  });

  const createResponse = await apiRequest("/payments/create-session", {
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
  assert.equal(createResponse.status, 200);

  await withPaymentAlertEmailStub(async sent => {
    await withPaymentEventsStub(async broadcasts => {
      const response = await apiRequest("/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "sig_payment_failed_lookup_error",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ok: true }),
      });

      assert.equal(response.status, 200);
      assert.equal(sent.length, 1);
      assert.equal(broadcasts.length, 0);
    });
  });

  const checkoutRow = sqlite
    .prepare(
      `SELECT status, payment_intent_id, stripe_event_id, stripe_event_type, error_message
       FROM checkout_sessions
       WHERE checkout_session_id = ?`
    )
    .get(sessionId);
  assert.deepEqual({ ...checkoutRow }, {
    status: "created",
    payment_intent_id: null,
    stripe_event_id: null,
    stripe_event_type: null,
    error_message: null,
  });
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
