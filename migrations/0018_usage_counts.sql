-- Anonymous daily step counts from the desktop app. No device, user, IP or
-- content is stored: only how many times each step happened per day,
-- platform and app version, so the product funnel is visible without consent-
-- gated identifiers.
CREATE TABLE IF NOT EXISTS usage_counts (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, event, platform, app_version)
);
