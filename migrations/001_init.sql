-- Initialize stage5-api database schema
-- Creates tables for credit management and webhook idempotency

CREATE TABLE IF NOT EXISTS credits (
  device_id TEXT PRIMARY KEY,
  minutes_remaining INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_credits_device_id ON credits(device_id);
CREATE INDEX IF NOT EXISTS idx_credits_updated_at ON credits(updated_at);
CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at ON processed_events(processed_at);
CREATE INDEX IF NOT EXISTS idx_processed_events_event_type ON processed_events(event_type); 