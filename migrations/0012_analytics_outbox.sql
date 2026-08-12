CREATE TABLE IF NOT EXISTS analytics_outbox (
  event_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  params_json TEXT NOT NULL,
  occurred_at_micros INTEGER NOT NULL,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at DATETIME,
  last_error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analytics_outbox_pending
  ON analytics_outbox (sent_at, available_at, created_at);
