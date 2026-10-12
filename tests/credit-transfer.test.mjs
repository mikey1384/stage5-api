import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { registerDeviceApiToken } from "../src/lib/db/api-tokens.ts";
import { WELCOME_CREDITS } from "../src/lib/db/credits.ts";
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
  return { deviceId, token: await registerDeviceApiToken({ deviceId }) };
}

async function call(device, path, body) {
  const res = await worker.fetch(
    new Request(`http://localhost/credits/${device.deviceId}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${device.token}`,
        "Content-Type": "application/json",
        "CF-Connecting-IP": `198.51.100.${Math.floor(Math.random() * 250)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  return { status: res.status, body: await res.json() };
}

function buy(device, credits) {
  sqlite
    .prepare(
      `INSERT INTO credits (device_id, credit_balance) VALUES (?, ?)
       ON CONFLICT(device_id) DO UPDATE SET credit_balance = credit_balance + excluded.credit_balance`,
    )
    .run(device.deviceId, credits);
  sqlite
    .prepare("INSERT INTO credit_ledger (device_id, delta, reason, meta) VALUES (?, ?, 'PACK_STARTER', 'null')")
    .run(device.deviceId, credits);
}

const balanceOf = (device) =>
  Number(sqlite.prepare("SELECT credit_balance AS b FROM credits WHERE device_id = ?").get(device.deviceId)?.b ?? 0);
const ledgerSum = (device) =>
  Number(sqlite.prepare("SELECT COALESCE(SUM(delta), 0) AS s FROM credit_ledger WHERE device_id = ?").get(device.deviceId).s);

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});
beforeEach(() => resetSqliteD1Database(sqlite));

test("purchased credits move to the new device, all of them and only once", async () => {
  const oldPc = await newDevice();
  const newPc = await newDevice();
  buy(oldPc, 150_000);

  const made = await call(oldPc, "/transfer-code", {});
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(made.body.transferableCredits, 150_000);

  const redeemed = await call(newPc, "/redeem-transfer", { code: made.body.code.toLowerCase().replace("-", " ") });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.transferredCredits, 150_000);
  assert.equal(balanceOf(newPc), 150_000);
  assert.equal(balanceOf(oldPc), 0);
  // The ledgers agree with the balances.
  assert.equal(ledgerSum(newPc), 150_000);
  assert.equal(ledgerSum(oldPc), 0);

  const again = await call(newPc, "/redeem-transfer", { code: made.body.code });
  assert.equal(again.status, 400);
  assert.equal(again.body.error, "invalid_code");
  assert.equal(balanceOf(newPc), 150_000);
});

test("welcome credits stay behind", async () => {
  const oldPc = await newDevice();
  const newPc = await newDevice();
  await call(oldPc, ""); // first balance check: welcome grant
  buy(oldPc, 15_000);
  const made = await call(oldPc, "/transfer-code", {});
  assert.equal(made.body.transferableCredits, 15_000);
  const redeemed = await call(newPc, "/redeem-transfer", { code: made.body.code });
  assert.equal(redeemed.body.transferredCredits, 15_000);
  assert.equal(balanceOf(oldPc), WELCOME_CREDITS);
  assert.equal(balanceOf(newPc), 15_000);
});

test("a device with only welcome credits has nothing to transfer", async () => {
  const pc = await newDevice();
  await call(pc, "");
  const made = await call(pc, "/transfer-code", {});
  assert.equal(made.status, 409);
  assert.equal(made.body.error, "nothing_to_transfer");
});

test("the BYO unlock moves with the credits", async () => {
  const oldPc = await newDevice();
  const newPc = await newDevice();
  sqlite
    .prepare("INSERT INTO entitlements (device_id, byo_openai, byo_anthropic, unlocked_at) VALUES (?, 1, 1, CURRENT_TIMESTAMP)")
    .run(oldPc.deviceId);
  const made = await call(oldPc, "/transfer-code", {});
  assert.equal(made.body.byoUnlock, true);
  const redeemed = await call(newPc, "/redeem-transfer", { code: made.body.code });
  assert.equal(redeemed.body.byoUnlock, true);
  const flags = (d) => sqlite.prepare("SELECT byo_openai, byo_anthropic FROM entitlements WHERE device_id = ?").get(d.deviceId);
  assert.deepEqual({ ...flags(newPc) }, { byo_openai: 1, byo_anthropic: 1 });
  assert.deepEqual({ ...flags(oldPc) }, { byo_openai: 0, byo_anthropic: 0 });
});

test("simultaneous redemptions move the credits once", async () => {
  const oldPc = await newDevice();
  const a = await newDevice();
  const b = await newDevice();
  buy(oldPc, 50_000);
  const { body } = await call(oldPc, "/transfer-code", {});
  const results = await Promise.all([
    call(a, "/redeem-transfer", { code: body.code }),
    call(b, "/redeem-transfer", { code: body.code }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(balanceOf(a) + balanceOf(b) + balanceOf(oldPc), 50_000);
  assert.equal(ledgerSum(a) + ledgerSum(b) + ledgerSum(oldPc), 50_000);
});

test("a failed redemption leaves the new device eligible for its welcome credits", async () => {
  const pc = await newDevice();
  const res = await call(pc, "/redeem-transfer", { code: "ABCDE-FGHJK" });
  assert.equal(res.status, 400);
  assert.equal((await call(pc, "")).body.creditBalance, WELCOME_CREDITS);
});

test("expired codes, the same device, and a newer code all refuse", async () => {
  const oldPc = await newDevice();
  const newPc = await newDevice();
  buy(oldPc, 10_000);
  const first = (await call(oldPc, "/transfer-code", {})).body.code;
  const second = (await call(oldPc, "/transfer-code", {})).body.code;
  assert.equal((await call(newPc, "/redeem-transfer", { code: first })).body.error, "invalid_code");
  assert.equal((await call(oldPc, "/redeem-transfer", { code: second })).body.error, "same_device");
  sqlite.prepare("UPDATE credit_transfer_codes SET expires_at = datetime('now', '-1 minute')").run();
  assert.equal((await call(newPc, "/redeem-transfer", { code: second })).body.error, "invalid_code");
  assert.equal(balanceOf(oldPc), 10_000);
});

test("a running job blocks the transfer until it finishes", async () => {
  const oldPc = await newDevice();
  const newPc = await newDevice();
  buy(oldPc, 10_000);
  sqlite
    .prepare("INSERT INTO billing_reservations (device_id, service, request_key, reserved_spend, status) VALUES (?, 'transcribe', 'job1', 500, 'reserved')")
    .run(oldPc.deviceId);
  const { body } = await call(oldPc, "/transfer-code", {});
  const res = await call(newPc, "/redeem-transfer", { code: body.code });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "jobs_running");
  // A reservation left over from long ago doesn't block.
  sqlite.prepare("UPDATE billing_reservations SET created_at = datetime('now', '-3 hours')").run();
  assert.equal((await call(newPc, "/redeem-transfer", { code: body.code })).status, 200);
});

test("codes are rate-limited per device", async () => {
  const pc = await newDevice();
  buy(pc, 10_000);
  for (let i = 0; i < 5; i++) assert.equal((await call(pc, "/transfer-code", {})).status, 200);
  assert.equal((await call(pc, "/transfer-code", {})).status, 429);
});
