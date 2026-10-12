import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { ensureDatabase } from "../src/lib/db/core.ts";
import { redactDeliveredAnalyticsDetails } from "../src/lib/analytics-retention.ts";
import { enqueueAnalyticsEvent } from "../src/lib/product-analytics.ts";
import { createSqliteD1Database, resetSqliteD1Database } from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();
const now = new Date("2026-09-06T12:00:00Z");
before(async () => { await ensureDatabase({ DB: db }); });
beforeEach(() => resetSqliteD1Database(sqlite));

function insert(id, sentAt, name = "app_open") {
  sqlite.prepare(`INSERT INTO analytics_outbox
    (event_id,event_name,client_id,params_json,occurred_at_micros,sent_at,created_at)
    VALUES (?,?,'123.456','{"locale":"ko"}',1,?,'2026-01-01 00:00:00')`)
    .run(id, name, sentAt);
}

test("retention removes only delivered details at the 90-day boundary", async () => {
  insert("old", "2026-06-01 12:00:00");
  insert("boundary", "2026-06-08 12:00:00");
  insert("recent", "2026-06-08 12:00:01");
  insert("pending", null);
  const before = sqlite.prepare("SELECT * FROM analytics_outbox WHERE event_id IN ('recent','pending') ORDER BY event_id").all();
  assert.deepEqual(await redactDeliveredAnalyticsDetails(now), { redacted: 2 });
  for (const id of ["old", "boundary"]) {
    const row = sqlite.prepare("SELECT * FROM analytics_outbox WHERE event_id = ?").get(id);
    assert.equal(row.client_id, "");
    assert.equal(row.params_json, "{}");
    assert.equal(row.event_name, "app_open");
    assert.ok(row.sent_at);
  }
  assert.deepEqual(sqlite.prepare("SELECT * FROM analytics_outbox WHERE event_id IN ('recent','pending') ORDER BY event_id").all(), before);
  assert.deepEqual(await redactDeliveredAnalyticsDetails(now), { redacted: 0 });
});

test("redaction preserves purchase deduplication without changing billing records", async () => {
  insert("purchase:pi_retention_test", "2026-01-01 00:00:00", "purchase");
  sqlite.prepare("INSERT INTO credits (device_id, credit_balance) VALUES ('test-device', 100)").run();
  const balanceBefore = sqlite.prepare("SELECT * FROM credits").all();
  assert.deepEqual(await redactDeliveredAnalyticsDetails(now), { redacted: 1 });
  assert.equal(await enqueueAnalyticsEvent({
    GA4_TRANSLATOR_MEASUREMENT_ID: "G-TEST", GA4_API_SECRET: "test-only",
    ANALYTICS_PSEUDONYM_SECRET: "test-only",
  }, {
    eventId: "purchase:pi_retention_test", eventName: "purchase",
    subjectKey: "test-device", params: { value: 5, currency: "USD" },
  }), "duplicate");
  assert.equal(sqlite.prepare("SELECT client_id FROM analytics_outbox").get().client_id, "");
  assert.deepEqual(sqlite.prepare("SELECT * FROM credits").all(), balanceBefore);
});

test("cleanup is bounded and later runs finish the remainder", async () => {
  for (let i = 0; i < 501; i++) insert(`old-${i}`, "2026-01-01 00:00:00");
  assert.deepEqual(await redactDeliveredAnalyticsDetails(now), { redacted: 500 });
  assert.deepEqual(await redactDeliveredAnalyticsDetails(now), { redacted: 1 });
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM analytics_outbox").get().n, 501);
});
