-- Exclude already-redacted receipts so recurring cleanup reads only candidates.
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_detail_retention
  ON analytics_outbox (sent_at, event_id)
  WHERE sent_at IS NOT NULL
    AND (client_id <> '' OR params_json <> '{}' OR last_error IS NOT NULL);
