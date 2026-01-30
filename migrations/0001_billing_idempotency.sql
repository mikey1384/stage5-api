-- Idempotency markers for billing operations (prevents double-charging on retries).
-- D1/SQLite compatible.

CREATE TABLE IF NOT EXISTS billing_idempotency (
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  spend INTEGER NOT NULL,
  meta TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, reason, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_billing_idempotency_device_created
  ON billing_idempotency (device_id, created_at);

