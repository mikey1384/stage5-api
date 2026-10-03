// Managed dubbing is ElevenLabs-only (OpenAI TTS shuts down 2027-01-06).
// Older Translator versions still send ttsProvider "openai", OpenAI models
// and OpenAI voice names; those must be synthesized with ElevenLabs v4 and
// reserved/settled at the v4 price.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, beforeEach, afterEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { creditDevice, getCredits, registerDeviceApiToken } from "../src/lib/db.ts";
import { STAGE5_TTS_MODEL_ELEVEN_V4 } from "../src/lib/model-catalog.ts";
import { charactersToCredits, estimateDubbingCredits } from "../src/lib/pricing.ts";
import {
  finalizeRelayCredits,
  reserveRelayCredits,
} from "../src/lib/relay-billing.ts";
import {
  DEFAULT_SPEECH_MODEL,
  OPENAI_TO_ELEVENLABS_VOICE,
  resolveDubVoice,
} from "../src/lib/constants.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();
const stored = new Map();

const env = {
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

function apiRequest(path, init = {}) {
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

async function setupDevice(deviceId) {
  const apiToken = await registerDeviceApiToken({ deviceId });
  await creditDevice({ deviceId, packId: "MICRO" });
  return apiToken;
}

function mockRelay(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const call = {
      url: href,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

test('legacy ttsProvider "openai" + voice "nova" dubs via ElevenLabs as rachel and bills at eleven_v4', async () => {
  const deviceId = "50000000-0000-4000-8000-000000000001";
  const apiToken = await setupDevice(deviceId);
  const before = (await getCredits({ deviceId })).credit_balance;

  const calls = mockRelay((call) => {
    if (call.url.endsWith("/dub-elevenlabs")) {
      return Response.json({
        voice: call.body.voice,
        model: "eleven_v4",
        format: "mp3",
        segmentCount: call.body.segments.length,
        segments: call.body.segments.map((s) => ({
          index: s.index,
          audioBase64: "AAAA",
          targetDuration: s.targetDuration,
        })),
      });
    }
    return new Response("unexpected", { status: 599 });
  });

  const segments = [
    { index: 1, start: 0, end: 1.5, translation: "Hello there" },
    { index: 2, start: 2, end: 3, translation: "General Kenobi" },
  ];
  const totalCharacters = "Hello there".length + "General Kenobi".length;
  const response = await apiRequest("/dub", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "dub-legacy-openai-1",
    },
    body: JSON.stringify({
      segments,
      voice: "nova",
      model: "tts-1-hd",
      quality: "high",
      format: "aac",
      ttsProvider: "openai",
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));

  // Only the relay's ElevenLabs endpoint is called (no /dub, no OpenAI).
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ["/dub-elevenlabs"],
  );
  assert.equal(calls[0].body.voice, "rachel");
  assert.equal(calls[0].body.format, "mp3");
  assert.equal(calls[0].headers["X-ElevenLabs-Key"], "elevenlabs-test-key");
  assert.equal(payload.model, "eleven_v4");
  assert.equal(payload.voice, "rachel");
  assert.equal(payload.usedElevenLabs, true);

  const expected = estimateDubbingCredits({
    characters: totalCharacters,
    model: STAGE5_TTS_MODEL_ELEVEN_V4,
  }).credits;
  const reservation = sqlite
    .prepare("SELECT * FROM billing_reservations WHERE device_id = ? AND service = 'tts'")
    .get(deviceId);
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.reserved_spend, expected);
  assert.equal(reservation.settled_spend, expected);
  const meta = JSON.parse(reservation.meta);
  assert.equal(meta.billedModel, "eleven_v4");
  assert.equal(meta.requestedTtsProvider, "openai");
  assert.equal(meta.requestedVoice, "nova");

  const after = (await getCredits({ deviceId })).credit_balance;
  assert.equal(before - after, expected);
});

test("ElevenLabs relay failure releases the reservation with no OpenAI fallback", async () => {
  const deviceId = "50000000-0000-4000-8000-000000000002";
  const apiToken = await setupDevice(deviceId);
  const before = (await getCredits({ deviceId })).credit_balance;
  const calls = mockRelay(() => new Response("ElevenLabs down", { status: 500 }));

  const response = await apiRequest("/dub", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "dub-fail-1",
    },
    body: JSON.stringify({
      segments: [{ index: 1, translation: "Hello" }],
      voice: "alloy",
      ttsProvider: "openai",
    }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ["/dub-elevenlabs"],
  );
  const reservation = sqlite
    .prepare("SELECT status FROM billing_reservations WHERE device_id = ? AND service = 'tts'")
    .get(deviceId);
  assert.equal(reservation.status, "released");
  assert.equal((await getCredits({ deviceId })).credit_balance, before);
});

test("/dub/estimate returns the ElevenLabs v4 price under every key, including the legacy OpenAI ones", async () => {
  const deviceId = "50000000-0000-4000-8000-000000000003";
  const apiToken = await setupDevice(deviceId);
  const response = await apiRequest("/dub/estimate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ characters: 10_000 }),
  });
  assert.equal(response.status, 200);
  const { estimates } = await response.json();
  const v4 = estimateDubbingCredits({ characters: 10_000, model: "eleven_v4" });
  assert.deepEqual(Object.keys(estimates).sort(), ["elevenlabs", "openai", "openaiHd"]);
  for (const key of ["openai", "openaiHd", "elevenlabs"]) {
    assert.equal(estimates[key].model, "eleven_v4", key);
    assert.equal(estimates[key].credits, v4.credits, key);
    assert.equal(estimates[key].usdCost, v4.usdEstimate, key);
  }
});

test("defaults and fallbacks price as eleven_v4, never tts-1", () => {
  assert.equal(DEFAULT_SPEECH_MODEL, "eleven_v4");
  const v4 = charactersToCredits({ characters: 1_000, model: "eleven_v4" });
  assert.equal(charactersToCredits({ characters: 1_000, model: "unknown-model" }), v4);
  assert.equal(estimateDubbingCredits({ characters: 1_000, model: "unknown-model" }).credits, v4);
  assert.deepEqual(OPENAI_TO_ELEVENLABS_VOICE, {
    alloy: "adam", echo: "brian", fable: "emily", onyx: "josh", nova: "rachel", shimmer: "sarah",
  });
  assert.equal(resolveDubVoice("Nova"), "rachel");
  assert.equal(resolveDubVoice("matilda"), "matilda");
  assert.equal(resolveDubVoice(undefined), "adam");
  assert.equal(resolveDubVoice("not-a-voice"), "adam");
});

test("relay TTS billing (Translator /dub-direct) reserves and settles at eleven_v4; a missing model defaults to it", async () => {
  const deviceId = "50000000-0000-4000-8000-000000000004";
  await setupDevice(deviceId);
  const v4 = charactersToCredits({ characters: 500, model: "eleven_v4" });

  // The relay now always sends model "eleven_v4" for managed dubbing.
  const reserved = await reserveRelayCredits({
    deviceId,
    service: "tts",
    requestKey: "tts:relay:1",
    characters: 500,
    model: "eleven_v4",
  });
  assert.ok(reserved.ok);
  const finalized = await finalizeRelayCredits({
    deviceId,
    service: "tts",
    requestKey: "tts:relay:1",
    characters: 500,
    model: "eleven_v4",
  });
  assert.ok(finalized.ok, JSON.stringify(finalized));

  const noModel = await reserveRelayCredits({
    deviceId,
    service: "tts",
    requestKey: "tts:relay:2",
    characters: 500,
  });
  assert.ok(noModel.ok);

  const rows = sqlite
    .prepare("SELECT request_key, reserved_spend, settled_spend FROM billing_reservations WHERE device_id = ? AND service = 'tts' ORDER BY request_key")
    .all(deviceId);
  assert.deepEqual(
    rows.map((r) => [r.request_key, r.reserved_spend, r.settled_spend]),
    [["tts:relay:1", v4, v4], ["tts:relay:2", v4, null]],
  );
});

test("no stage5-api source calls OpenAI speech synthesis or the relay's OpenAI /dub", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) {
        const source = readFileSync(full, "utf8");
        if (/audio\s*\.\s*speech|\/dub`|callSpeechDirect\(|callDubRelay\(/.test(source)) {
          offenders.push(full);
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
