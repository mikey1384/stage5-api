CREATE TABLE IF NOT EXISTS checkout_sessions (
  checkout_session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('credits', 'entitlement')),
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'fulfilled', 'failed', 'cancelled')),
  pack_id TEXT,
  entitlement TEXT,
  credits_delta INTEGER,
  payment_intent_id TEXT,
  stripe_event_id TEXT,
  stripe_event_type TEXT,
  credit_balance_after INTEGER,
  entitlements_json TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_device_created
  ON checkout_sessions (device_id, created_at);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_payment_intent
  ON checkout_sessions (payment_intent_id);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status_updated
  ON checkout_sessions (status, updated_at);
