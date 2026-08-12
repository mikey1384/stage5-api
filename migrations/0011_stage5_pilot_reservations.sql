CREATE TABLE IF NOT EXISTS stage5_pilot_reservations (
  checkout_session_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE,
  experiment_tag TEXT NOT NULL CHECK(experiment_tag = 'phantom_fund_experiment'),
  offer_code TEXT NOT NULL CHECK(offer_code = 'creator_localization_25'),
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'completed', 'invalidated')),
  source TEXT NOT NULL,
  locale TEXT NOT NULL,
  customer_email TEXT,
  video_url TEXT,
  target_language TEXT,
  rights_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(rights_confirmed IN (0, 1)),
  stripe_event_id TEXT,
  stripe_event_type TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_stage5_pilot_reservations_status_created
  ON stage5_pilot_reservations (status, created_at);

CREATE INDEX IF NOT EXISTS idx_stage5_pilot_reservations_experiment_created
  ON stage5_pilot_reservations (experiment_tag, created_at);
