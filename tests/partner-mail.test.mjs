import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import worker from "../src/index.ts";
import { createSqliteD1Database } from "./helpers/sqlite-d1.mjs";

const { db } = createSqliteD1Database();

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
  SENDGRID_API_KEY: "SG.test",
  ALERT_EMAIL_FROM: "alerts@stage5.tools",
  PARTNER_MAIL_SECRET: "partner-secret",
};

const ctx = { waitUntil() {}, passThroughOnException() {} };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function send(body, { secret = "partner-secret", envOverride = {} } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["x-partner-mail-secret"] = secret;
  return worker.fetch(
    new Request("http://localhost/partner-mail/send", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { ...env, ...envOverride },
    ctx
  );
}

const valid = {
  to: "Client@Example.com",
  toName: "Isis",
  subject: "Your photo walk\r\nBcc: x@y.z",
  text: "See you tomorrow.",
  replyTo: "contact@momentik.kr",
  fromName: "MOMENTIK",
  partner: "momentik",
};

test("partner mail is disabled when no secret is configured", async () => {
  const res = await send(valid, { envOverride: { PARTNER_MAIL_SECRET: "" } });
  assert.equal(res.status, 404);
});

test("partner mail rejects a missing or wrong secret", async () => {
  assert.equal((await send(valid, { secret: "" })).status, 401);
  assert.equal((await send(valid, { secret: "nope" })).status, 401);
});

test("partner mail validates the payload", async () => {
  assert.equal((await send({ ...valid, to: "not-an-email" })).status, 400);
  assert.equal((await send({ ...valid, replyTo: "bad" })).status, 400);
  assert.equal((await send({ ...valid, subject: "" })).status, 400);
  assert.equal((await send({ ...valid, text: " " })).status, 400);
  assert.equal((await send({ ...valid, text: "x".repeat(20_001) })).status, 413);
});

test("partner mail sends one message through SendGrid from the Stage5 sender", async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(null, { status: 202, headers: { "x-message-id": "msg_1" } });
  };
  const res = await send(valid);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, messageId: "msg_1" });
  assert.equal(captured.url, "https://api.sendgrid.com/v3/mail/send");
  assert.equal(captured.init.headers.authorization, "Bearer SG.test");
  assert.deepEqual(captured.body.personalizations, [
    { to: [{ email: "client@example.com", name: "Isis" }] },
  ]);
  assert.deepEqual(captured.body.from, { email: "alerts@stage5.tools", name: "MOMENTIK" });
  assert.deepEqual(captured.body.reply_to, { email: "contact@momentik.kr" });
  assert.equal(captured.body.subject, "Your photo walk Bcc: x@y.z");
  assert.deepEqual(captured.body.categories, ["partner-mail", "momentik"]);
  assert.equal(captured.body.mail_settings, undefined);

  await send({ ...valid, sandbox: true });
  assert.deepEqual(captured.body.mail_settings, { sandbox_mode: { enable: true } });
});

test("partner mail reports SendGrid failures without leaking the key", async () => {
  globalThis.fetch = async () => new Response("bad from", { status: 403 });
  const res = await send(valid);
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.error, "send_failed");
  assert.ok(!JSON.stringify(json).includes("SG.test"));
});
