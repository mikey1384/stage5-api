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

## Notes
- Keep this file updated when secrets change
- Never commit actual secret values to git in code files
- This reference file is safe to commit since secrets are set separately in Cloudflare 
