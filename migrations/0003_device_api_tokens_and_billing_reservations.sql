CREATE TABLE IF NOT EXISTS device_api_tokens (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_device_api_tokens_token_hash
  ON device_api_tokens (token_hash);

CREATE TABLE IF NOT EXISTS billing_reservations (
  device_id TEXT NOT NULL,
  service TEXT NOT NULL,
  request_key TEXT NOT NULL,
  reserved_spend INTEGER NOT NULL,
  settled_spend INTEGER,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'settled', 'released')),
  meta TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, service, request_key)
);

CREATE INDEX IF NOT EXISTS idx_billing_reservations_status_updated
  ON billing_reservations (status, updated_at);
