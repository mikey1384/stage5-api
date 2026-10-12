-- One-time codes that move a device's purchased credits (and BYO unlock) to
-- another device. Only a hash of the code is stored.
CREATE TABLE IF NOT EXISTS credit_transfer_codes (
  code_hash TEXT PRIMARY KEY,
  from_device_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  redeemed_at DATETIME,
  to_device_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_credit_transfer_codes_from
  ON credit_transfer_codes (from_device_id, created_at);
