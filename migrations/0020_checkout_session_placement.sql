-- Where in the app a credit checkout started (e.g. free-preview-offer,
-- settings-credit-card). Lets fulfilled payments be traced to the feature
-- that asked for them. NULL for older app versions.
ALTER TABLE checkout_sessions ADD COLUMN placement TEXT;
