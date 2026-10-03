// Managed transcription is ElevenLabs Scribe only (OpenAI whisper-1 and
// gpt-4o-transcribe shut down 2027-02-26; their replacement has no timestamps).
// Older Translator versions still send model "whisper-1" / qualityMode=false;
// those must be served by Scribe and reserved/settled at the Scribe price, and
// no response may ask the client to confirm a Whisper fallback.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, beforeEach, afterEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { creditDevice, getCredits, registerDeviceApiToken } from "../src/lib/db.ts";
import { STAGE5_ELEVENLABS_SCRIBE_MODEL } from "../src/lib/model-catalog.ts";
import { secondsToCredits } from "../src/lib/pricing.ts";
import {
  confirmRelayReservation,
  finalizeRelayCredits,
  reserveRelayCredits,
} from "../src/lib/relay-billing.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();
const stored = new Map();

const baseEnv = {
  DB: db,
  ALLOWED_ORIGINS: "https://translator.tools",
  UI_ORIGIN: "https://translator.tools",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  STRIPE_BYO_UNLOCK_PRICE_ID: "price_byo_unlock",
  RELAY_SECRET: "relay-secret",
  OPENAI_API_KEY: "openai-test-key",
  ELEVENLABS_API_KEY: "elevenlabs-test-key",
  TRANSCRIPTION_BUCKET: {
    async put(key, body) {
      stored.set(key, typeof body === "string" ? body : String(body));
    },
    async get(key) {
      const body = stored.get(key);
      return body === undefined ? null : { text: async () => body };
    },
    async delete(key) {
      stored.delete(key);
    },
  },
  RECONCILE_CRON_ENABLED: "0",
  RECONCILE_CRON_DRY_RUN: "0",
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const originalFetch = globalThis.fetch;
const scribe = (seconds) =>
  secondsToCredits({ seconds, model: STAGE5_ELEVENLABS_SCRIBE_MODEL });
const whisper = (seconds) => secondsToCredits({ seconds, model: "whisper-1" });
const RESERVE_PADDING_SECONDS = 2;

function apiRequest(path, init = {}, env = baseEnv) {
  return worker.fetch(new Request(`http://localhost${path}`, init), env, ctx);
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
  stored.clear();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function setupDevice(deviceId, balance) {
  const apiToken = await registerDeviceApiToken({ deviceId });
  await creditDevice({ deviceId, packId: "MICRO" });
  if (typeof balance === "number") {
    sqlite
      .prepare("UPDATE credits SET credit_balance = ? WHERE device_id = ?")
      .run(balance, deviceId);
  }
  return apiToken;
}

function mockRelay(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const call = {
      url: href,
      headers: init.headers ?? {},
      form: init.body instanceof FormData ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

function scribeShapedResult(durationSeconds) {
  return {
    text: "Hello there",
    language: "en",
    duration: durationSeconds,
    approx_duration: durationSeconds,
    model: STAGE5_ELEVENLABS_SCRIBE_MODEL,
    segments: [
      {
        id: 0,
        start: 0,
        end: durationSeconds,
        text: "Hello there",
        words: [
          { word: "Hello", start: 0, end: 0.5 },
          { word: "there", start: 0.6, end: durationSeconds },
        ],
      },
    ],
    words: [
      { word: "Hello", start: 0, end: 0.5 },
      { word: "there", start: 0.6, end: durationSeconds },
    ],
  };
}

function legacyWhisperForm({ durationSec }) {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(64)], "audio.webm", { type: "audio/webm" })
  );
  // Exactly what Translator <= 1.22.0 sends after a confirmed Whisper fallback.
  form.append("model", "whisper-1");
  form.append("qualityMode", "false");
  form.append("durationSec", String(durationSec));
  form.append("language", "en");
  form.append("prompt", "speaker names");
  return form;
}

function transcribeRequest(apiToken, form, idempotencyKey) {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: form,
  };
}

function transcriptionReservations(deviceId) {
  return sqlite
    .prepare(
      "SELECT status, reserved_spend, settled_spend, meta FROM billing_reservations WHERE device_id = ? AND service = 'transcription'"
    )
    .all(deviceId);
}

test('old client model "whisper-1" + qualityMode=false is transcribed by Scribe and billed at the Scribe price', async () => {
  const deviceId = "70000000-0000-4000-8000-000000000001";
  const apiToken = await setupDevice(deviceId);
  const balanceBefore = (await getCredits({ deviceId })).credit_balance;

  const calls = mockRelay((call) => {
    if (new URL(call.url).pathname === "/transcribe") {
      // An older relay could still have attached a fallback marker; the worker
      // must never pass one through.
      return Response.json({
        ...scribeShapedResult(60),
        fallback: { from: "elevenlabs-scribe", to: "whisper-1", attempts: 3 },
      });
    }
    return new Response("unexpected", { status: 599 });
  });

  const response = await apiRequest(
    "/transcribe",
    transcribeRequest(apiToken, legacyWhisperForm({ durationSec: 60 }), "tx-legacy-1")
  );
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));

  // Only the relay's Scribe-backed /transcribe is called, never OpenAI.
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ["/transcribe"]
  );
  const relayCall = calls[0];
  assert.equal(relayCall.form.get("model"), "scribe_v2");
  assert.equal(relayCall.form.get("qualityMode"), "true");
  assert.equal(relayCall.form.get("prompt"), null);
  assert.equal(relayCall.headers["X-OpenAI-Key"], undefined);
  assert.equal(relayCall.headers["X-ElevenLabs-Key"], "elevenlabs-test-key");

  // Success shape unchanged for old clients, and no fallback object.
  assert.equal(payload.text, "Hello there");
  assert.equal(payload.model, STAGE5_ELEVENLABS_SCRIBE_MODEL);
  assert.equal(payload.segments[0].start, 0);
  assert.equal(payload.segments[0].end, 60);
  assert.equal(payload.segments[0].text, "Hello there");
  assert.equal(payload.segments[0].words.length, 2);
  assert.equal("fallback" in payload, false);

  const [reservation] = transcriptionReservations(deviceId);
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.reserved_spend, scribe(60 + RESERVE_PADDING_SECONDS));
  assert.equal(reservation.settled_spend, scribe(60));
  assert.notEqual(reservation.settled_spend, whisper(60));
  const meta = JSON.parse(reservation.meta);
  assert.equal(meta.billedModel, STAGE5_ELEVENLABS_SCRIBE_MODEL);
  assert.equal(meta.provider, "ElevenLabs");
  assert.equal(meta.requestedModel, "whisper-1");

  const balanceAfter = (await getCredits({ deviceId })).credit_balance;
  assert.equal(balanceBefore - balanceAfter, scribe(60));
});

test("Scribe unavailable after relay retries: 502 transcription-provider-unavailable, reservation released, no OpenAI call", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000002";
  const apiToken = await setupDevice(deviceId);
  const balanceBefore = (await getCredits({ deviceId })).credit_balance;
  const calls = mockRelay(() =>
    Response.json(
      {
        error: "transcription-provider-unavailable",
        details:
          "Transcription is temporarily unavailable. Please try again in a few minutes.",
      },
      { status: 502 }
    )
  );

  const response = await apiRequest(
    "/transcribe",
    transcribeRequest(apiToken, legacyWhisperForm({ durationSec: 30 }), "tx-down-1")
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "transcription-provider-unavailable",
    message:
      "Transcription is temporarily unavailable. Please try again in a few minutes.",
  });
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ["/transcribe"]
  );
  assert.ok(calls.every((c) => !c.url.includes("openai.com")));

  const [reservation] = transcriptionReservations(deviceId);
  assert.equal(reservation.status, "released");
  assert.equal((await getCredits({ deviceId })).credit_balance, balanceBefore);
});

test("a relay gateway outage (bare 503) is reported as provider-unavailable and releases the hold", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000003";
  const apiToken = await setupDevice(deviceId);
  const balanceBefore = (await getCredits({ deviceId })).credit_balance;
  mockRelay(() => new Response("upstream connect error", { status: 503 }));

  const response = await apiRequest(
    "/transcribe",
    transcribeRequest(apiToken, legacyWhisperForm({ durationSec: 30 }), "tx-gw-1")
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "transcription-provider-unavailable");
  assert.equal(transcriptionReservations(deviceId)[0].status, "released");
  assert.equal((await getCredits({ deviceId })).credit_balance, balanceBefore);
});

test("insufficient credits returns the normal 402 insufficient-credits, never a Whisper fallback confirmation", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000004";
  const reserveSeconds = 3600 + RESERVE_PADDING_SECONDS;
  // Enough for the old Whisper price but not for Scribe: exactly the case
  // that used to answer transcription-fallback-confirmation-required.
  const balance = whisper(reserveSeconds) + 10;
  assert.ok(balance < scribe(reserveSeconds));
  const apiToken = await setupDevice(deviceId, balance);
  const calls = mockRelay(() => new Response("unexpected", { status: 599 }));

  const form = legacyWhisperForm({ durationSec: 3600 });
  form.set("model", "scribe_v2");
  form.set("qualityMode", "true");
  const response = await apiRequest(
    "/transcribe",
    transcribeRequest(apiToken, form, "tx-poor-1")
  );
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { error: "insufficient-credits" });
  assert.equal(calls.length, 0);
  assert.equal((await getCredits({ deviceId })).credit_balance, balance);
});

test("with only an OpenAI key configured the worker refuses (502) before holding credits", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000005";
  const apiToken = await setupDevice(deviceId);
  const balanceBefore = (await getCredits({ deviceId })).credit_balance;
  const calls = mockRelay(() => new Response("unexpected", { status: 599 }));
  const { ELEVENLABS_API_KEY: _omit, ...openAiOnlyEnv } = baseEnv;

  const response = await apiRequest(
    "/transcribe",
    transcribeRequest(apiToken, legacyWhisperForm({ durationSec: 30 }), "tx-nokey-1"),
    openAiOnlyEnv
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "transcription-provider-unavailable");
  assert.equal(calls.length, 0);
  assert.equal(transcriptionReservations(deviceId).length, 0);
  assert.equal((await getCredits({ deviceId })).credit_balance, balanceBefore);
});

test("relay billing (Translator /transcribe-direct) holds at the Scribe price whatever model the relay names", async () => {
  const deviceId = "70000000-0000-4000-8000-000000000006";
  await setupDevice(deviceId);

  for (const [requestKey, model] of [
    ["tx:relay:whisper", "whisper-1"],
    ["tx:relay:none", undefined],
    ["tx:relay:scribe", "elevenlabs-scribe"],
  ]) {
    const reserved = await reserveRelayCredits({
      deviceId,
      service: "transcription",
      requestKey,
      seconds: 100,
      ...(model ? { model } : {}),
    });
    assert.ok(reserved.ok, JSON.stringify(reserved));
  }
  // A confirm top-up naming whisper-1 still tops up to the Scribe price.
  const confirmed = await confirmRelayReservation({
    deviceId,
    service: "transcription",
    requestKey: "tx:relay:whisper",
    seconds: 200,
    model: "whisper-1",
  });
  assert.ok(confirmed.ok, JSON.stringify(confirmed));

  const rows = sqlite
    .prepare(
      "SELECT request_key, reserved_spend FROM billing_reservations WHERE device_id = ? AND service = 'transcription' ORDER BY request_key"
    )
    .all(deviceId);
  assert.deepEqual(
    rows.map((r) => [r.request_key, r.reserved_spend]),
    [
      ["tx:relay:none", scribe(100)],
      ["tx:relay:scribe", scribe(100)],
      ["tx:relay:whisper", scribe(200)],
    ]
  );

  const finalized = await finalizeRelayCredits({
    deviceId,
    service: "transcription",
    requestKey: "tx:relay:scribe",
    seconds: 90,
    model: "elevenlabs-scribe",
  });
  assert.ok(finalized.ok, JSON.stringify(finalized));
  // Only a pending finalize recorded before the Scribe-only deploy (Whisper
  // work that already ran) may still settle at the retired whisper-1 rate.
  const legacySettle = await finalizeRelayCredits({
    deviceId,
    service: "transcription",
    requestKey: "tx:relay:none",
    seconds: 90,
    model: "whisper-1",
  });
  assert.ok(legacySettle.ok, JSON.stringify(legacySettle));
  const settled = sqlite
    .prepare(
      "SELECT request_key, settled_spend FROM billing_reservations WHERE device_id = ? AND service = 'transcription' AND status = 'settled' ORDER BY request_key"
    )
    .all(deviceId);
  assert.deepEqual(
    settled.map((r) => [r.request_key, r.settled_spend]),
    [
      ["tx:relay:none", whisper(90)],
      ["tx:relay:scribe", scribe(90)],
    ]
  );
});

test("no stage5-api source calls OpenAI transcription or offers a Whisper fallback", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) {
        const source = readFileSync(full, "utf8");
        if (
          /audio\s*\.\s*transcriptions|audio\/transcriptions|transcription-fallback-confirmation-required/.test(
            source
          )
        ) {
          offenders.push(full);
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
