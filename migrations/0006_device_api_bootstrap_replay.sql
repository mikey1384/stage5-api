ALTER TABLE device_api_tokens
  ADD COLUMN legacy_bootstrap_allowed INTEGER NOT NULL DEFAULT 1;

ALTER TABLE device_api_tokens
  ADD COLUMN pending_issue_kind TEXT
  CHECK (pending_issue_kind IN ('legacy', 'recovery'));

ALTER TABLE device_api_tokens
  ADD COLUMN pending_issue_nonce TEXT;

ALTER TABLE device_api_tokens
  ADD COLUMN pending_recovery_binding_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_device_api_tokens_pending_recovery_binding_hash
  ON device_api_tokens (pending_recovery_binding_hash);
