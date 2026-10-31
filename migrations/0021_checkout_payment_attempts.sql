-- Why a checkout did not end in a payment. Each failed attempt reported by
-- Stripe (payment_intent.payment_failed, async_payment_failed) overwrites the
-- last_payment_* fields and bumps payment_attempt_failures; the session stays
-- 'created' while Stripe keeps it open so the buyer can retry.
-- expired_at is set when Stripe expires the session (checkout.session.expired
-- or the scheduled checkout sweep). Additive columns only: no rewrite, no lock.
ALTER TABLE checkout_sessions ADD COLUMN last_payment_error_code TEXT;
ALTER TABLE checkout_sessions ADD COLUMN last_payment_decline_code TEXT;
ALTER TABLE checkout_sessions ADD COLUMN last_payment_error_message TEXT;
ALTER TABLE checkout_sessions ADD COLUMN last_payment_method_type TEXT;
ALTER TABLE checkout_sessions ADD COLUMN last_payment_error_at DATETIME;
ALTER TABLE checkout_sessions ADD COLUMN payment_attempt_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_sessions ADD COLUMN expired_at DATETIME;
