import assert from "node:assert/strict";
import test, { before, beforeEach, afterEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { registerDeviceApiToken } from "../src/lib/db/api-tokens.ts";
import { clearRelayCapabilitiesCacheForTests } from "../src/lib/relay-capabilities.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();
const originalFetch = globalThis.fetch;

const baseEnv = {
  DB: db,
  ALLOWED_ORIGINS: "https://translator.tools",
  UI_ORIGIN: "https://translator.tools",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
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

async function apiRequest(path, init = {}, envOverrides = {}) {
  const request = new Request(`http://localhost${path}`, init);
  return worker.fetch(request, { ...baseEnv, ...envOverrides }, ctx);
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
  globalThis.fetch = originalFetch;
  clearRelayCapabilitiesCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("entitlements stage5 review capability follows relay truth when worker env says Anthropic is available", async () => {
  const deviceId = "91111111-1111-4111-8111-111111111111";
  const apiToken = await registerDeviceApiToken({ deviceId });

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url;
    assert.equal(url, "https://translator-relay.fly.dev/translation-capabilities");
    assert.equal(init?.headers?.["X-Relay-Secret"], "relay-secret");
    assert.equal(init?.headers?.["X-Stage5-Worker-Anthropic-Available"], "1");
    return new Response(
      JSON.stringify({
        capabilities: { stage5AnthropicReviewAvailable: false },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const response = await apiRequest(
    `/entitlements/${deviceId}`,
    {
      headers: authHeaders(apiToken),
    },
    {
      ANTHROPIC_API_KEY: "worker-anthropic-key",
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.capabilities.stage5AnthropicReviewAvailable, false);
});

test("entitlements stage5 review capability follows relay truth when worker env lacks Anthropic support", async () => {
  const deviceId = "92222222-2222-4222-8222-222222222222";
  const apiToken = await registerDeviceApiToken({ deviceId });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        capabilities: { stage5AnthropicReviewAvailable: true },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  const response = await apiRequest(`/entitlements/${deviceId}`, {
    headers: authHeaders(apiToken),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.capabilities.stage5AnthropicReviewAvailable, true);
});

test("entitlements reuses cached relay review capability when probe fails", async () => {
  const deviceId = "93333333-3333-4333-8333-333333333333";
  const apiToken = await registerDeviceApiToken({ deviceId });

  let capabilityCalls = 0;
  globalThis.fetch = async () => {
    capabilityCalls += 1;
    if (capabilityCalls === 1) {
      return new Response(
        JSON.stringify({
          capabilities: { stage5AnthropicReviewAvailable: true },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    throw new Error("relay capability probe failed");
  };

  const warmResponse = await apiRequest(`/entitlements/${deviceId}`, {
    headers: authHeaders(apiToken),
  });
  assert.equal(warmResponse.status, 200);
  const warmBody = await warmResponse.json();
  assert.equal(warmBody.capabilities.stage5AnthropicReviewAvailable, true);

  const fallbackResponse = await apiRequest(`/entitlements/${deviceId}`, {
    headers: authHeaders(apiToken),
  });
  assert.equal(fallbackResponse.status, 200);
  const fallbackBody = await fallbackResponse.json();
  assert.equal(fallbackBody.capabilities.stage5AnthropicReviewAvailable, true);
  assert.equal(capabilityCalls, 2);
});
