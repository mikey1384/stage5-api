-- One row per credit hold refused for insufficient balance, so blocked jobs
-- (which otherwise leave no ledger or reservation row) can be monitored.
CREATE TABLE IF NOT EXISTS billing_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  service TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('reserve', 'increase')),
  requested_spend INTEGER NOT NULL,
  balance INTEGER,
  reason TEXT,
  meta TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_billing_rejections_created
  ON billing_rejections (created_at);
CREATE INDEX IF NOT EXISTS idx_billing_rejections_device
  ON billing_rejections (device_id, created_at);
