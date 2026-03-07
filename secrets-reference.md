# Secrets Reference

This file documents the secrets used in the stage5-api project. These are **NOT** used directly in code - they must be set as Cloudflare Worker secrets.

## How to set secrets

### Via Cloudflare Dashboard
1. Go to Cloudflare Workers dashboard
2. Select the `stage5-api` worker
3. Go to Settings → Variables
4. Add as "Secret" (encrypted)

### Via CLI
```bash
wrangler secret put SECRET_NAME
```

## Current Secrets

### RELAY_SECRET
- **Value:** `translator-relay-secret-2024`
- **Purpose:** Authentication between stage5-api and openai-relay server
- **Used in:** Fallback requests to bypass geo-blocking

### OPENAI_API_KEY
- **Value:** `sk-...` (your OpenAI API key)
- **Purpose:** Authentication with OpenAI API
- **Used in:** Direct OpenAI calls and passed to relay server

### STRIPE_BYO_UNLOCK_PRICE_ID
- **Value:** Stripe price ID for the $10 "Bring Your Own OpenAI" unlock (e.g. `price_123456789`)
- **Purpose:** Enables creation of one-time checkout sessions that unlock BYO OpenAI entitlements
- **Used in:** `/payments/create-byo-unlock` endpoint when generating checkout sessions

### ADMIN_API_SECRET
- **Value:** A dedicated secret string for admin-only routes
- **Purpose:** Authorizes `/admin/*` maintenance actions such as add/reset credits
- **Used in:** Admin tooling via `X-Admin-Secret`

### ADMIN_DEVICE_ID
- **Value:** Legacy admin secret value
- **Purpose:** Backward-compatible fallback when `ADMIN_API_SECRET` has not been rolled out yet
- **Used in:** `/admin/*` routes only when `ADMIN_API_SECRET` is unset

### DEVICE_TOKEN_SECRET
- **Value:** Optional dedicated secret for deterministic `/auth/device-token` replay
- **Purpose:** Seeds the D1-backed canonical device-token root secret when you want explicit initial secret control
- **Used in:** Device token bootstrap and recovery replay

## Notes
- Keep this file updated when secrets change
- Never commit actual secret values to git in code files
- This reference file is safe to commit since secrets are set separately in Cloudflare
- stage5-api persists a canonical device-token secret in D1 on first use. If `DEVICE_TOKEN_SECRET` is set, it is used only as the initial seed value.
- Later `DEVICE_TOKEN_SECRET` changes do not retroactively change pending replays or issued device-token credentials.
