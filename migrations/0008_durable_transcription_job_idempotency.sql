CREATE TABLE IF NOT EXISTS transcription_jobs (
  job_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  file_key TEXT,
  language TEXT,
  result TEXT,
  error TEXT,
  duration_seconds INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE transcription_jobs
  ADD COLUMN client_request_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transcription_jobs_device_client_request_key
  ON transcription_jobs (device_id, client_request_key);
