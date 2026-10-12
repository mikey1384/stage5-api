CREATE TABLE analytics_preferences (
  client_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE analytics_outbox ADD COLUMN discarded_at DATETIME;
ALTER TABLE analytics_outbox ADD COLUMN discard_reason TEXT;
CREATE INDEX idx_analytics_outbox_expiry
  ON analytics_outbox(occurred_at_micros, event_id)
  WHERE sent_at IS NULL AND discarded_at IS NULL;
