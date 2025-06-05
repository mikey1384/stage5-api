-- Create processed_events table for webhook idempotency
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster lookups and cleanup
CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at ON processed_events(processed_at);

-- Create index for event type if needed for analytics
CREATE INDEX IF NOT EXISTS idx_processed_events_event_type ON processed_events(event_type); 