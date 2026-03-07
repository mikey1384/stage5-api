import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { createSqliteD1Database, resetSqliteD1Database } from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();

const env = {
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

async function apiRequest(path, init = {}, envOverride = {}) {
  const request = new Request(`http://localhost${path}`, init);
  return worker.fetch(request, { ...env, ...envOverride }, ctx);
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
});

test("admin routes accept the legacy ADMIN_DEVICE_ID secret when ADMIN_API_SECRET is unset", async () => {
  const response = await apiRequest(
    "/admin/add-credits",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Admin-Secret": "legacy-admin-secret",
      },
      body: JSON.stringify({
        deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        pack: "MICRO",
      }),
    },
    {
      ADMIN_DEVICE_ID: "legacy-admin-secret",
      ADMIN_API_SECRET: "",
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.creditsAdded, 15000);
});
