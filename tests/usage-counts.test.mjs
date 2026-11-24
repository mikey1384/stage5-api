import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import {
  CHECKOUT_PACK_COUNT_MISMATCH_EVENT,
  FREE_PREVIEW_DISMISS_REASON_EVENTS,
  HANDOFF_USAGE_COUNT_EVENTS,
  clampUsageDay,
} from "../src/routes/usage.ts";
import { PRODUCT_EVENT_NAMES } from "../src/routes/analytics.ts";
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

test("the download handoff names are accepted as anonymous counts", async () => {
  assert.deepEqual([...HANDOFF_USAGE_COUNT_EVENTS], [
    "home_translate_clicked",
    "home_download_only_clicked",
    "download_handoff_shown",
    "download_handoff_clicked",
    "download_handoff_dismissed",
    "download_handoff_translation_started",
  ]);
  const counts = HANDOFF_USAGE_COUNT_EVENTS.map((event) => ({ event, day: today, n: 2 }));
  // Mixed with an established name, as an app may send them in one batch.
  counts.push({ event: "app_open", day: today, n: 1 });
  assert.equal(
    (await post({ appVersion: "1.33.0", platform: "darwin", counts })).status,
    204,
  );
  const stored = rows();
  assert.equal(stored.length, 7);
  for (const event of HANDOFF_USAGE_COUNT_EVENTS) {
    assert.equal(stored.find((r) => r.event === event)?.count, 2, event);
  }
});

test("handoff names stay out of the opt-in analytics allow-list", () => {
  for (const event of HANDOFF_USAGE_COUNT_EVENTS) {
    assert.ok(!PRODUCT_EVENT_NAMES.includes(event), event);
  }
});

test("the free-preview dismissal reasons are accepted as anonymous counts only", async () => {
  assert.deepEqual([...FREE_PREVIEW_DISMISS_REASON_EVENTS], [
    "free_preview_dismiss_price",
    "free_preview_dismiss_quality",
    "free_preview_dismiss_enough",
    "free_preview_dismiss_trying",
    "free_preview_dismiss_download_only",
  ]);
  const counts = FREE_PREVIEW_DISMISS_REASON_EVENTS.map((event) => ({
    event,
    day: today,
    n: 3,
  }));
  assert.equal(
    (await post({ appVersion: "1.34.0", platform: "win32", counts })).status,
    204,
  );
  const stored = rows();
  assert.equal(stored.length, 5);
  for (const event of FREE_PREVIEW_DISMISS_REASON_EVENTS) {
    assert.equal(stored.find((r) => r.event === event)?.count, 3, event);
    assert.ok(!PRODUCT_EVENT_NAMES.includes(event), event);
  }
});

test("the checkout pack-count mismatch is accepted as an anonymous count only", async () => {
  assert.equal(CHECKOUT_PACK_COUNT_MISMATCH_EVENT, "checkout_pack_count_mismatch");
  assert.equal(
    (
      await post({
        appVersion: "1.36.0",
        platform: "darwin",
        counts: [{ event: CHECKOUT_PACK_COUNT_MISMATCH_EVENT, day: today, n: 1 }],
      })
    ).status,
    204,
  );
  assert.equal(
    rows().find((r) => r.event === CHECKOUT_PACK_COUNT_MISMATCH_EVENT)?.count,
    1,
  );
  assert.ok(!PRODUCT_EVENT_NAMES.includes(CHECKOUT_PACK_COUNT_MISMATCH_EVENT));
});
