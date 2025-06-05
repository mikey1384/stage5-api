# Stage5 API

A unified API service for Stage 5 applications, handling payments, credit management, and shared features.

## 🏗️ Architecture

```
┌────────────────────┐               ┌───────────────────────┐
│  stage5.tools web  │───https──────▶│  stage5-api (Stripe)  │
└────────────────────┘               │  • POST /payments     │
┌────────────────────┐               │  • POST /webhook      │
│  Translator app    │───https──────▶│  • GET  /credits      │
└────────────────────┘               │  • …                  │
                                      └─────────┬────────────┘
                                                ▼
                                       Managed DB (credits)
```

## 🚀 Tech Stack

- **Runtime**: Hono on Cloudflare Workers (or Node.js)
- **Types**: TypeScript + Zod for validation
- **Database**: D1 (SQLite) or Postgres
- **Payments**: Stripe
- **Deploy**: Cloudflare Workers, Fly.io, or Railway

## 📁 Project Structure

```
stage5-api/
├─ src/
│  ├─ index.ts            ← Main Hono app
│  ├─ routes/
│  │   ├─ payments.ts     ← Payment session creation
│  │   ├─ webhook.ts      ← Stripe webhook handling
│  │   └─ credits.ts      ← Credit management
│  ├─ lib/
│  │   ├─ stripe.ts       ← Stripe client
│  │   └─ db.ts           ← Database operations
│  └─ types/
│      └─ packs.ts        ← Credit pack definitions
├─ wrangler.toml          ← Cloudflare Workers config
└─ package.json
```

## 🛠️ Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Setup

Copy the example environment file:

```bash
cp .env.example .env
```

Set the following environment variables:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
UI_ORIGIN=https://stage5.tools
ALLOWED_ORIGINS=https://stage5.tools,http://localhost:3000
```

### 3. Database Setup

For Cloudflare Workers with D1:

```bash
# Create D1 database
wrangler d1 create stage5-credits

# Update wrangler.toml with the database ID
# Run migrations
wrangler d1 execute stage5-credits --file=./migrations/001_create_tables.sql
```

### 4. Stripe Configuration

1. Create products and prices in your Stripe dashboard
2. Update the price IDs in `src/types/packs.ts`
3. Set up webhook endpoint in Stripe dashboard pointing to `/stripe/webhook`

## 🏃‍♂️ Development

### Local Development

```bash
# Start development server
npm run dev

# For webhook testing
stripe listen --forward-to localhost:8787/stripe/webhook
```

### Type Checking

```bash
npm run type-check
```

### Build

```bash
npm run build
```

## 🚀 Deployment

### Cloudflare Workers

```bash
# Set secrets
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET

# Deploy
wrangler deploy
```

### Other Platforms

The service is compatible with:

- Fly.io
- Railway
- Render
- Vercel
- Any Node.js hosting

## 📚 API Documentation

### Endpoints

#### `GET /`

Health check endpoint.

**Response:**

```json
{
  "service": "stage5-api",
  "version": "1.0.0",
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### `GET /payments/packs`

Get available credit packs.

**Response:**

```json
{
  "packs": [
    {
      "id": "HOUR_1",
      "name": "1 Hour Pack",
      "minutes": 60,
      "price": 999,
      "description": "Perfect for quick translations"
    }
  ]
}
```

#### `POST /payments/create-session`

Create a Stripe checkout session.

**Request:**

```json
{
  "packId": "HOUR_1",
  "deviceId": "123e4567-e89b-12d3-a456-426614174000"
}
```

**Response:**

```json
{
  "url": "https://checkout.stripe.com/pay/...",
  "sessionId": "cs_test_..."
}
```

#### `GET /credits/:deviceId`

Get credit balance for a device.

**Response:**

```json
{
  "deviceId": "123e4567-e89b-12d3-a456-426614174000",
  "minutesRemaining": 120,
  "hasCredits": true,
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

#### `POST /credits/:deviceId/deduct`

Deduct credits from a device.

**Request:**

```json
{
  "minutes": 30,
  "reason": "Translation session"
}
```

**Response:**

```json
{
  "success": true,
  "deductedMinutes": 30,
  "remainingMinutes": 90,
  "reason": "Translation session"
}
```

#### `POST /stripe/webhook`

Stripe webhook endpoint for processing payments.

### Error Responses

All endpoints return consistent error responses:

```json
{
  "error": "Error Type",
  "message": "Detailed error message",
  "details": [] // Optional validation details
}
```

## 🔐 Security

- All webhook signatures are verified
- Device IDs must be valid UUIDs
- CORS is properly configured
- Rate limiting should be added for production

## 📊 Monitoring

Consider adding:

- Error tracking (Sentry)
- Performance monitoring
- Usage analytics
- Rate limiting

## 🤝 Integration

### Frontend Integration

```javascript
// Create checkout session
const response = await fetch(
  "https://api.stage5.tools/payments/create-session",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      packId: "HOUR_1",
      deviceId: "your-device-uuid",
    }),
  }
);

const { url } = await response.json();
window.location.href = url;
```

### Electron App Integration

```javascript
// Check credits
const checkCredits = async (deviceId) => {
  const response = await fetch(`https://api.stage5.tools/credits/${deviceId}`);
  return response.json();
};

// Deduct credits
const deductCredits = async (deviceId, minutes) => {
  const response = await fetch(
    `https://api.stage5.tools/credits/${deviceId}/deduct`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes, reason: "Translation" }),
    }
  );
  return response.json();
};
```

## 📝 License

MIT License - see LICENSE file for details.
