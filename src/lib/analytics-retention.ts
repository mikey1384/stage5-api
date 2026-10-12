import { getDatabase } from "./db/core";

export const DELIVERED_ANALYTICS_DETAIL_RETENTION_DAYS = 90;
const CLEANUP_BATCH_SIZE = 500;
export const PENDING_ANALYTICS_RETENTION_MS = 72 * 60 * 60 * 1000;

// Expired or non-consented events are discarded, never marked as delivered.
// Keep minimal deduplication receipts; do not touch fulfillment or balances.
export async function discardIneligibleAnalytics(now = new Date()): Promise<{ discarded: number }> {
  const result = await getDatabase().prepare(`UPDATE analytics_outbox
    SET discarded_at = CURRENT_TIMESTAMP, available_at = '9999-12-31T23:59:59.999Z',
        discard_reason = CASE WHEN occurred_at_micros <= ? THEN 'expired' ELSE 'consent_missing' END,
        client_id = '', params_json = '{}', last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE event_id IN (SELECT event_id FROM analytics_outbox
      WHERE sent_at IS NULL AND discarded_at IS NULL
        AND (occurred_at_micros <= ? OR NOT EXISTS
          (SELECT 1 FROM analytics_preferences p WHERE p.client_id = analytics_outbox.client_id AND p.enabled = 1))
      ORDER BY occurred_at_micros, event_id LIMIT ?)`)
    .bind((now.getTime() - PENDING_ANALYTICS_RETENTION_MS) * 1000,
      (now.getTime() - PENDING_ANALYTICS_RETENTION_MS) * 1000, CLEANUP_BATCH_SIZE).run();
  return { discarded: Number(result?.meta?.changes ?? 0) };
}

// Keep event IDs and delivery receipts: removing them could report a retried
// purchase or app event twice. Pending delivery and billing tables are untouched.
export async function redactDeliveredAnalyticsDetails(
  now = new Date(),
): Promise<{ redacted: number }> {
  const result = await getDatabase()
    .prepare(
      `UPDATE analytics_outbox
       SET client_id = '', params_json = '{}', last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE event_id IN (
         SELECT event_id FROM analytics_outbox
         WHERE sent_at IS NOT NULL
           AND sent_at <= datetime(?, ?)
           AND (client_id <> '' OR params_json <> '{}' OR last_error IS NOT NULL)
         ORDER BY sent_at, event_id
         LIMIT ?
       )`,
    )
    .bind(
      now.toISOString(),
      `-${DELIVERED_ANALYTICS_DETAIL_RETENTION_DAYS} days`,
      CLEANUP_BATCH_SIZE,
    )
    .run();
  return { redacted: Number(result?.meta?.changes ?? 0) };
}
