-- Create credits table for tracking device credit balances
CREATE TABLE IF NOT EXISTS credits (
  device_id TEXT PRIMARY KEY,
  minutes_remaining INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_credits_device_id ON credits(device_id);

-- Create index for timestamp queries if needed for analytics
CREATE INDEX IF NOT EXISTS idx_credits_updated_at ON credits(updated_at); 