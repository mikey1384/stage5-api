-- Shared durable store for relay-side translation jobs.
-- This prevents multi-instance Fly routing from losing in-memory relay job state.

CREATE TABLE IF NOT EXISTS relay_translation_jobs (
  relay_job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
  result TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_relay_translation_jobs_status_updated
  ON relay_translation_jobs (status, updated_at);
