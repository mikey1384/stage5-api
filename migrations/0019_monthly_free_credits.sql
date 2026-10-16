-- Month (YYYY-MM, UTC) a device last had its monthly free top-up decided, so
-- each device is topped up at most once per calendar month.
ALTER TABLE credits ADD COLUMN monthly_free_month TEXT;
