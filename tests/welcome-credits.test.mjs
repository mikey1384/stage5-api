import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { registerDeviceApiToken } from "../src/lib/db/api-tokens.ts";
import {
  WELCOME_CREDITS,
  WELCOME_MAX_PER_DAY,
  WELCOME_MAX_PER_IP_PER_DAY,
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

async function newDevice() {
  const deviceId = randomUUID();
  const token = await registerDeviceApiToken({ deviceId });
  return { deviceId, token };
}

async function balance({ deviceId, token }, ip = "203.0.113.7") {
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

function ledger(deviceId) {
  return sqlite
    .prepare("SELECT delta, reason, meta FROM credit_ledger WHERE device_id = ?")
    .all(deviceId);
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
});

test("a device that never had credits gets the welcome grant once", async () => {
  const device = await newDevice();
  const first = await balance(device);
  assert.equal(first.creditBalance, WELCOME_CREDITS);
  const again = await balance(device);
  assert.equal(again.creditBalance, WELCOME_CREDITS);
  const rows = ledger(device.deviceId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "WELCOME");
  assert.equal(rows[0].delta, WELCOME_CREDITS);
  // Only a short hash of the IP is kept.
  assert.doesNotMatch(rows[0].meta, /203\.0\.113\.7/);
});

test("concurrent first balance checks grant once", async () => {
  const device = await newDevice();
  const results = await Promise.all([balance(device), balance(device), balance(device)]);
  for (const r of results) assert.ok(r.creditBalance === WELCOME_CREDITS || r.creditBalance === 0);
  assert.equal(ledger(device.deviceId).filter((r) => r.reason === "WELCOME").length, 1);
  assert.equal((await balance(device)).creditBalance, WELCOME_CREDITS);
});

test("a device that spent down to zero is not granted again", async () => {
  const device = await newDevice();
  await balance(device);
  sqlite.prepare("UPDATE credits SET credit_balance = 0 WHERE device_id = ?").run(device.deviceId);
  assert.equal((await balance(device)).creditBalance, 0);
  assert.equal(ledger(device.deviceId).length, 1);
});

test("a device with ledger history but no credits row is not granted", async () => {
  const device = await newDevice();
  sqlite
    .prepare("INSERT INTO credit_ledger (device_id, delta, reason, meta) VALUES (?, ?, ?, ?)")
    .run(device.deviceId, -100, "TRANSCRIBE", "null");
  assert.equal((await balance(device)).creditBalance, 0);
});

test("grants are capped per IP per day", async () => {
  for (let i = 0; i < WELCOME_MAX_PER_IP_PER_DAY; i++) {
    assert.equal((await balance(await newDevice(), "198.51.100.1")).creditBalance, WELCOME_CREDITS);
  }
  assert.equal((await balance(await newDevice(), "198.51.100.1")).creditBalance, 0);
  // Another IP is unaffected.
  assert.equal((await balance(await newDevice(), "198.51.100.2")).creditBalance, WELCOME_CREDITS);
});

test("grants are capped per day overall", async () => {
  const insert = sqlite.prepare(
    "INSERT INTO credit_ledger (device_id, delta, reason, meta) VALUES (?, ?, 'WELCOME', ?)",
  );
  for (let i = 0; i < WELCOME_MAX_PER_DAY; i++) insert.run(randomUUID(), WELCOME_CREDITS, JSON.stringify({ ipHash: `h${i}` }));
  assert.equal((await balance(await newDevice(), "192.0.2.50")).creditBalance, 0);
});

test("dev and test launches are marked on the welcome grant; anything else is not", async () => {
  const fetchWith = async (build) => {
    const device = await newDevice();
    const headers = {
      Authorization: `Bearer ${device.token}`,
      "CF-Connecting-IP": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    };
    if (build !== undefined) headers["X-Stage5-App-Build"] = build;
    const res = await worker.fetch(
      new Request(`http://localhost/credits/${device.deviceId}`, { headers }),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // The mark never changes what the device gets.
    assert.equal(body.creditBalance, WELCOME_CREDITS);
    return JSON.parse(ledger(device.deviceId)[0].meta);
  };
  assert.equal((await fetchWith("dev")).build, "dev");
  assert.equal((await fetchWith("test")).build, "test");
  assert.equal((await fetchWith("release")).build, undefined);
  assert.equal((await fetchWith(undefined)).build, undefined);
});
