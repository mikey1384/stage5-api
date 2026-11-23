import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { before, beforeEach } from "node:test";

import { ensureDatabase } from "../src/lib/db/core.ts";
import { parseJobDetails } from "../src/lib/job-details.ts";
import {
  KNOWN_VIDEO_SITES,
  VIDEO_SITE_ALIASES,
} from "../src/shared/known-video-sites.ts";
import {
  confirmRelayReservation,
  persistRelayReservationMeta,
  reserveRelayCredits,
} from "../src/lib/relay-billing.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});
beforeEach(() => resetSqliteD1Database(sqlite));

const full = {
  sourceLanguage: "en",
  targetLanguage: "chinese_simplified",
  videoSeconds: 4321,
  sourceSite: "youtube.com",
};

test("the four fields are kept, from header text or an object", () => {
  assert.deepEqual(parseJobDetails(JSON.stringify(full)), full);
  assert.deepEqual(parseJobDetails(full), full);
});

test("values are normalised", () => {
  assert.deepEqual(
    parseJobDetails({
      sourceLanguage: " EN ",
      targetLanguage: "Korean",
      videoSeconds: 61.6,
      sourceSite: "Vimeo.COM",
    }),
    {
      sourceLanguage: "en",
      targetLanguage: "korean",
      videoSeconds: 62,
      sourceSite: "vimeo.com",
    },
  );
});

test("anything that is not one of the four fields is dropped", () => {
  assert.deepEqual(
    parseJobDetails({
      ...full,
      title: "My holiday",
      url: "https://youtube.com/watch?v=abc",
      fileName: "holiday.mp4",
    }),
    full,
  );
});

test("a site is kept by name only when it is a well-known video site", () => {
  for (const sourceSite of KNOWN_VIDEO_SITES) {
    assert.deepEqual(parseJobDetails({ sourceSite }), { sourceSite });
  }
  // Private, identifying or simply unlisted hosts are never stored by name.
  for (const sourceSite of [
    "jira.acme-corp.internal",
    "nas.local",
    "plex.tail1234.ts.net",
    "acme.sharepoint.com",
    "my-private-bucket.s3.amazonaws.com",
    "10.0.0.1.nip.io",
    "johnsmith-family-videos.com",
    "www.youtube.com",
    "xn--oy2b35ckwhba574atvuzkc.com",
    "other",
  ]) {
    assert.deepEqual(
      parseJobDetails({ sourceSite }),
      { sourceSite: "other" },
      sourceSite,
    );
  }
});

test("a site that is not a host name is dropped", () => {
  for (const sourceSite of [
    "https://youtube.com/watch?v=abc",
    "youtube.com/watch?v=abc",
    "youtube.com:8080",
    "user@youtube.com",
    "localhost",
    "192.168.0.10",
    "[::1]",
    "you tube.com",
    "a".repeat(120) + ".com",
    42,
  ]) {
    assert.equal(parseJobDetails({ sourceSite }), null, String(sourceSite));
  }
});

test("languages are a code or an app language token, not free text", () => {
  for (const value of ["en", "eng", "pt-br", "korean", "chinese_simplified"]) {
    assert.deepEqual(parseJobDetails({ sourceLanguage: value }), {
      sourceLanguage: value,
    });
  }
  for (const value of [
    "my-secret-video-title",
    "holiday2024",
    "a",
    "one_two_three_four",
    "korean ",
    "x".repeat(40),
  ]) {
    const parsed = parseJobDetails({ targetLanguage: value });
    assert.ok(
      parsed === null || parsed.targetLanguage === value.trim(),
      value,
    );
  }
  assert.equal(parseJobDetails({ targetLanguage: "my-secret-video-title" }), null);
  assert.equal(parseJobDetails({ targetLanguage: "holiday2024" }), null);
  assert.equal(parseJobDetails({ targetLanguage: "one_two_three_four" }), null);
});

test("the app and the API agree on the known sites", async () => {
  const appCopy = await import(
    "../../translator/packages/shared/constants/known-video-sites.ts"
  );
  assert.deepEqual([...appCopy.KNOWN_VIDEO_SITES], [...KNOWN_VIDEO_SITES]);
  assert.deepEqual(appCopy.VIDEO_SITE_ALIASES, VIDEO_SITE_ALIASES);
  for (const target of Object.values(VIDEO_SITE_ALIASES)) {
    assert.ok(KNOWN_VIDEO_SITES.includes(target), target);
  }
});

test("a bad field is dropped without losing the good ones", () => {
  assert.deepEqual(
    parseJobDetails({
      sourceLanguage: "a sentence, not a language",
      targetLanguage: "korean",
      videoSeconds: -5,
      sourceSite: "youtube.com",
    }),
    { targetLanguage: "korean", sourceSite: "youtube.com" },
  );
  assert.equal(parseJobDetails({ videoSeconds: "600" }), null);
  assert.equal(parseJobDetails({ videoSeconds: 8 * 24 * 3600 }), null);
});

test("unusable input gives nothing", () => {
  for (const raw of [undefined, null, "", "not json", "[1,2]", "42", [], 7]) {
    assert.equal(parseJobDetails(raw), null, String(raw));
  }
  assert.equal(
    parseJobDetails(JSON.stringify({ ...full, pad: "x".repeat(600) })),
    null,
  );
});

function ledgerMeta(deviceId) {
  return sqlite
    .prepare("SELECT reason, meta FROM credit_ledger WHERE device_id = ?")
    .all(deviceId)
    .map((row) => ({ reason: row.reason, meta: JSON.parse(row.meta) }));
}

function fund(deviceId) {
  sqlite
    .prepare("INSERT INTO credits(device_id, credit_balance) VALUES(?, ?)")
    .run(deviceId, 100_000);
}

test("a relay hold stores validated details on the credit record", async () => {
  const deviceId = randomUUID();
  fund(deviceId);
  const result = await reserveRelayCredits({
    deviceId,
    service: "translation",
    requestKey: "job-details-1",
    promptTokens: 1000,
    maxCompletionTokens: 1000,
    model: "claude-haiku-5-5",
    meta: { directRequestLease: "lease", job: { title: "smuggled" } },
    jobDetails: JSON.stringify({ ...full, title: "My holiday" }),
  });
  assert.equal(result.ok, true);
  const rows = ledgerMeta(deviceId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "TRANSLATE_RESERVE");
  assert.deepEqual(rows[0].meta.job, full);
  assert.equal(rows[0].meta.directRequestLease, "lease");
});

test("a relay hold without details records none, and relay meta cannot add them", async () => {
  const deviceId = randomUUID();
  fund(deviceId);
  const result = await reserveRelayCredits({
    deviceId,
    service: "translation",
    requestKey: "job-details-2",
    promptTokens: 1000,
    maxCompletionTokens: 1000,
    model: "claude-haiku-5-5",
    meta: { job: { title: "smuggled" } },
  });
  assert.equal(result.ok, true);
  const rows = ledgerMeta(deviceId);
  assert.equal(rows.length, 1);
  assert.equal("job" in rows[0].meta, false);
});

test("a refused hold keeps no job details", async () => {
  const deviceId = randomUUID();
  sqlite
    .prepare("INSERT INTO credits(device_id, credit_balance) VALUES(?, ?)")
    .run(deviceId, 1);
  const result = await reserveRelayCredits({
    deviceId,
    service: "translation",
    requestKey: "job-details-refused",
    promptTokens: 100000,
    maxCompletionTokens: 100000,
    model: "claude-haiku-5-5",
    jobDetails: JSON.stringify(full),
  });
  assert.equal(result.ok, false);
  assert.equal(ledgerMeta(deviceId).length, 0);
  const rejections = sqlite
    .prepare("SELECT meta FROM billing_rejections WHERE device_id = ?")
    .all(deviceId);
  assert.equal(rejections.length, 1);
  const meta = JSON.parse(rejections[0].meta);
  assert.equal("job" in meta, false);
  assert.equal(meta.requestKey, "job-details-refused");
});

test("later relay calls cannot add a job to a hold's meta", async () => {
  const deviceId = randomUUID();
  fund(deviceId);
  const base = {
    deviceId,
    service: "translation",
    requestKey: "job-details-later",
    model: "claude-haiku-5-5",
  };
  assert.equal(
    (
      await reserveRelayCredits({
        ...base,
        promptTokens: 1000,
        maxCompletionTokens: 1000,
      })
    ).ok,
    true,
  );
  await confirmRelayReservation({ ...base, meta: { job: { title: "x" }, note: 1 } });
  await persistRelayReservationMeta({ ...base, meta: { job: { title: "x" } } });
  const stored = sqlite
    .prepare(
      "SELECT json_extract(meta, '$.job') AS job FROM billing_reservations WHERE device_id = ?",
    )
    .all(deviceId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].job, null);
});
