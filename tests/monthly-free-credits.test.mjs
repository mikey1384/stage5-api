import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { registerDeviceApiToken } from "../src/lib/db/api-tokens.ts";
import {
  MONTHLY_FREE_CREDITS,
  MONTHLY_FREE_MAX_PER_IP_PER_DAY,
  WELCOME_CREDITS,
} from "../src/lib/db/credits.ts";
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
  RELAY_SECRET: "relay-secret",
  OPENAI_API_KEY: "openai-test-key",
  RECONCILE_CRON_ENABLED: "0",
  RECONCILE_CRON_DRY_RUN: "0",
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const month = new Date().toISOString().slice(0, 7);

async function newDevice() {
  const deviceId = randomUUID();
  const token = await registerDeviceApiToken({ deviceId });
  return { deviceId, token };
}

async function balance({ deviceId, token }, ip = "203.0.113.20") {
  const res = await worker.fetch(
    new Request(`http://localhost/credits/${deviceId}`, {
      headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": ip },
    }),
    env,
    ctx,
  );
  assert.equal(res.status, 200);
  return res.json();
}

/** An existing device from before this month, with the given balance. */
function seed(deviceId, credits, freeMonth = null) {
  sqlite
    .prepare(
      "INSERT INTO credits (device_id, credit_balance, monthly_free_month) VALUES (?, ?, ?)",
    )
    .run(deviceId, credits, freeMonth);
  sqlite
    .prepare("INSERT INTO credit_ledger (device_id, delta, reason) VALUES (?, ?, 'PACK_MICRO')")
    .run(deviceId, credits);
}

const monthlyRows = (deviceId) =>
  sqlite
    .prepare("SELECT delta, meta FROM credit_ledger WHERE device_id = ? AND reason = 'MONTHLY_FREE'")
    .all(deviceId);

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});
beforeEach(() => {
  sqlite.prepare("DELETE FROM credit_ledger").run();
  sqlite.prepare("DELETE FROM credits").run();
});

test("a new device gets the welcome grant and no extra monthly top-up that month", async () => {
  const device = await newDevice();
  const first = await balance(device);
  assert.equal(first.creditBalance, WELCOME_CREDITS);
  assert.equal(first.monthlyFree.credits, MONTHLY_FREE_CREDITS);
  assert.equal(first.monthlyFree.month, month);
  assert.match(first.monthlyFree.refreshesOn, /^\d{4}-\d{2}-01$/);
  sqlite.prepare("UPDATE credits SET credit_balance = 10 WHERE device_id = ?").run(device.deviceId);
  const later = await balance(device);
  assert.equal(later.creditBalance, 10);
  assert.equal(monthlyRows(device.deviceId).length, 0);
});

test("an existing device below the allowance is topped up once per month", async () => {
  const device = await newDevice();
  seed(device.deviceId, 300);
  const first = await balance(device);
  assert.equal(first.creditBalance, MONTHLY_FREE_CREDITS);
  assert.equal(first.monthlyFree.grantedNow, MONTHLY_FREE_CREDITS - 300);
  const rows = monthlyRows(device.deviceId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, MONTHLY_FREE_CREDITS - 300);
  assert.equal(JSON.parse(rows[0].meta).month, month);

  // Spending it down again in the same month does not refill.
  sqlite.prepare("UPDATE credits SET credit_balance = 0 WHERE device_id = ?").run(device.deviceId);
  assert.equal((await balance(device)).creditBalance, 0);
  assert.equal(monthlyRows(device.deviceId).length, 1);

  // Next month (simulated by an older decided month) it refills again.
  sqlite.prepare("UPDATE credits SET monthly_free_month = '2000-01' WHERE device_id = ?").run(device.deviceId);
  assert.equal((await balance(device)).creditBalance, MONTHLY_FREE_CREDITS);
  assert.equal(monthlyRows(device.deviceId).length, 2);
});

test("a device holding at least the allowance gets nothing, even after spending later that month", async () => {
  const device = await newDevice();
  seed(device.deviceId, 9_000);
  assert.equal((await balance(device)).creditBalance, 9_000);
  sqlite.prepare("UPDATE credits SET credit_balance = 50 WHERE device_id = ?").run(device.deviceId);
  assert.equal((await balance(device)).creditBalance, 50);
  assert.equal(monthlyRows(device.deviceId).length, 0);
});

test("top-ups from one network are capped per day; capped devices stay eligible", async () => {
  const devices = [];
  for (let i = 0; i <= MONTHLY_FREE_MAX_PER_IP_PER_DAY; i += 1) {
    const device = await newDevice();
    seed(device.deviceId, 0);
    devices.push(device);
  }
  const results = [];
  for (const device of devices) results.push((await balance(device, "198.51.100.7")).creditBalance);
  assert.equal(results.filter((n) => n === MONTHLY_FREE_CREDITS).length, MONTHLY_FREE_MAX_PER_IP_PER_DAY);
  const capped = devices[devices.length - 1];
  assert.equal(results[results.length - 1], 0);
  // The same device on another network later that day still gets its month.
  assert.equal((await balance(capped, "192.0.2.44")).creditBalance, MONTHLY_FREE_CREDITS);
});
