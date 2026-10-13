import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { clampUsageDay } from "../src/routes/usage.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
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
const today = new Date().toISOString().slice(0, 10);

function post(body) {
  return worker.fetch(
    new Request("http://localhost/usage/counts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const rows = () =>
  sqlite.prepare("SELECT * FROM usage_counts ORDER BY event").all();

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});
beforeEach(() => sqlite.prepare("DELETE FROM usage_counts").run());

test("counts accumulate per day, event, platform and version without auth", async () => {
  const body = {
    appVersion: "1.25.0",
    platform: "win32",
    counts: [
      { event: "app_first_open", day: today, n: 1 },
      { event: "url_download_started", day: today, n: 3 },
    ],
  };
  assert.equal((await post(body)).status, 204);
  assert.equal((await post(body)).status, 204);
  const stored = rows();
  assert.deepEqual(
    stored.map((r) => [r.day, r.event, r.platform, r.app_version, r.count]),
    [
      [today, "app_first_open", "win32", "1.25.0", 2],
      [today, "url_download_started", "win32", "1.25.0", 6],
    ],
  );
  // Nothing about the sender is stored.
  assert.deepEqual(Object.keys(stored[0]).sort(), [
    "app_version", "count", "day", "event", "platform", "updated_at",
  ]);
});

test("unknown events, oversized counts and bad versions are rejected", async () => {
  for (const counts of [
    [{ event: "video_title_seen", day: today, n: 1 }],
    [{ event: "app_open", day: today, n: 501 }],
    [{ event: "app_open", day: today, n: 0 }],
  ]) {
    assert.equal(
      (await post({ appVersion: "1.25.0", platform: "darwin", counts })).status,
      400,
    );
  }
  assert.equal(
    (await post({
      appVersion: "dev build",
      platform: "darwin",
      counts: [{ event: "app_open", day: today, n: 1 }],
    })).status,
    400,
  );
  assert.equal(rows().length, 0);
});

test("days in the future or older than two weeks are counted on today", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  assert.equal(clampUsageDay("2026-10-12", now), "2026-10-12");
  assert.equal(clampUsageDay("2026-09-29", now), "2026-09-29");
  assert.equal(clampUsageDay("2026-09-28", now), "2026-10-13");
  assert.equal(clampUsageDay("2026-10-14", now), "2026-10-13");
});
