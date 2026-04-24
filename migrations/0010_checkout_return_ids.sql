ALTER TABLE checkout_sessions
  ADD COLUMN checkout_return_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_return_id
  ON checkout_sessions (checkout_return_id);
