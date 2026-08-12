CREATE TABLE IF NOT EXISTS internal_devices (
  device_id TEXT PRIMARY KEY,
  classification TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_internal_devices_classification
  ON internal_devices (classification, updated_at);
