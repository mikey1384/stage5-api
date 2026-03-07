CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at
  ON processed_events (processed_at);

CREATE TABLE IF NOT EXISTS stripe_fulfillments (
  fulfillment_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  fulfillment_kind TEXT NOT NULL CHECK(fulfillment_kind IN ('credits', 'entitlement')),
  checkout_session_id TEXT,
  payment_intent_id TEXT,
  stripe_event_id TEXT,
  stripe_event_type TEXT NOT NULL,
  meta TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stripe_fulfillments_device_created
  ON stripe_fulfillments (device_id, created_at);

CREATE INDEX IF NOT EXISTS idx_stripe_fulfillments_checkout_session
  ON stripe_fulfillments (checkout_session_id);

CREATE INDEX IF NOT EXISTS idx_stripe_fulfillments_payment_intent
  ON stripe_fulfillments (payment_intent_id);
