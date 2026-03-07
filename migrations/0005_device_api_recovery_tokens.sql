ALTER TABLE device_api_tokens
  ADD COLUMN recovery_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_device_api_tokens_recovery_hash
  ON device_api_tokens (recovery_token_hash);
