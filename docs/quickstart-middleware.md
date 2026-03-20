# Quickstart: Middleware Mode

Embed MPP card payments directly into your server. Full control, your infrastructure.

## 1. Install

```bash
npm install @mpp-endpoint/middleware
```

## 2. Add payment gating to a route

### Hono / Bun / Cloudflare Workers

```typescript
import { Hono } from 'hono'
import { mppCard } from '@mpp-endpoint/middleware'

const app = new Hono()

const mpp = mppCard({
  merchantName: 'Acme Weather API',
  acceptedNetworks: ['visa'],
  gateway: {
    // Your acquirer's authorization endpoint
    async charge({ token, amount, currency, idempotencyKey }) {
      const res = await fetch('https://gateway.acquirer.com/v1/authorize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.ACQUIRER_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          network_token: token.pan,
          cryptogram: token.cryptogram,
          exp_month: token.expirationMonth,
          exp_year: token.expirationYear,
          amount,
          currency,
        }),
      })
      const data = await res.json()
      return { reference: data.transaction_id, status: data.approved ? 'success' : 'declined' }
    },
  },
})

// Gate your endpoint behind a $5.00 charge
app.get('/weather', mpp.charge({ amount: '500', currency: 'usd' }), async (c) => {
  const city = c.req.query('city')
  return c.json({ city, temp_f: 62, conditions: 'Partly cloudy' })
})

export default app
```

That's a complete MPP-compatible endpoint. The middleware handles:
- Returning 402 challenges with the correct `WWW-Authenticate` header
- RSA key generation and management
- JWE decryption of encrypted network tokens
- Forwarding the decrypted token to your gateway adapter
- Attaching `Payment-Receipt` headers on success

### Next.js

```typescript
// app/api/weather/route.ts
import { mppCard } from '@mpp-endpoint/middleware/nextjs'

const mpp = mppCard({
  merchantName: 'Acme Weather API',
  acceptedNetworks: ['visa'],
  gateway: { /* same as above */ },
})

export const GET = mpp.charge({ amount: '500', currency: 'usd' })(
  async () => Response.json({ temp_f: 62, conditions: 'Partly cloudy' })
)
```

### Express

```typescript
import express from 'express'
import { mppCard } from '@mpp-endpoint/middleware/express'

const app = express()

const mpp = mppCard({
  merchantName: 'Acme Weather API',
  acceptedNetworks: ['visa'],
  gateway: { /* same as above */ },
})

app.get('/weather', mpp.charge({ amount: '500', currency: 'usd' }), (req, res) => {
  res.json({ city: req.query.city, temp_f: 62, conditions: 'Partly cloudy' })
})

app.listen(3000)
```

## 3. Test it

```bash
npx mppx http://localhost:3000/weather?city=sf
```

```json
{
  "city": "sf",
  "temp_f": 62,
  "conditions": "Partly cloudy"
}
```

## Configuration reference

### `mppCard(options)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `merchantName` | `string` | Yes | Display name shown in the 402 challenge |
| `acceptedNetworks` | `string[]` | Yes | Card networks to accept (e.g., `["visa"]`) |
| `gateway` | `ServerEnabler` | Yes | Your acquirer gateway adapter (see below) |
| `privateKey` | `string` | No | RSA-2048 PEM private key. If omitted, the middleware generates one on startup. |
| `secretKey` | `string` | No | HMAC key for challenge integrity. If omitted, one is generated. |
| `billingRequired` | `boolean` | No | Request billing address from the agent. Default: `false` |
| `keyManagementUrl` | `string` | No | Fetch keys from the managed service instead of local generation |

### `mpp.charge(options)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `amount` | `string` | Yes | Charge amount in smallest currency unit (e.g., `"500"` = $5.00) |
| `currency` | `string` | Yes | ISO 4217 currency code (e.g., `"usd"`) |
| `description` | `string` | No | Human-readable description for the payment |
| `externalId` | `string` | No | Your reference ID for this transaction |

### Gateway adapter interface

The `gateway` object must implement one method:

```typescript
interface ServerEnabler {
  charge(params: {
    token: {
      pan: string           // Network token PAN
      cryptogram: string    // Payment cryptogram
      expirationMonth: string
      expirationYear: string
      billingAddress?: {    // Present when billingRequired is true
        street: string
        city: string
        state: string
        postalCode: string
        country: string
      }
    }
    amount: string          // Smallest currency unit
    currency: string        // ISO 4217
    idempotencyKey: string  // Derived from challenge ID
  }): Promise<{
    reference: string       // Transaction ID from your processor
    status: 'success' | 'declined' | 'error'
  }>
}
```

## Key management options

### Auto-generated (default)

The middleware generates an RSA-2048 key pair on startup. Simple, but the key changes on every restart.

### Explicit key

Provide your own PEM key for persistence across restarts:

```typescript
const mpp = mppCard({
  privateKey: process.env.MPP_PRIVATE_KEY,  // RSA-2048 PEM
  // ...
})
```

### Managed key service

Fetch keys from the MPP Endpoint Service's key management API. Keys are stored in an HSM and rotated automatically:

```typescript
const mpp = mppCard({
  keyManagementUrl: 'https://api.mpp-endpoint.com/v1/keys',
  // ...
})
```

This is recommended for production. You get HSM-backed storage and automatic rotation without managing keys yourself.

## Discovery endpoint

Add a `/discover` route so agents can find your endpoints:

```typescript
app.get('/discover', mpp.discover({
  merchant: 'Acme',
  services: [
    {
      id: 'weather',
      name: 'Acme Weather API',
      description: 'Real-time weather data for any city',
      routes: [{ method: 'GET', path: '/weather' }],
    },
  ],
}))
```

```bash
curl http://localhost:3000/discover
```

```json
{
  "merchant": "Acme",
  "services": [
    {
      "id": "weather",
      "name": "Acme Weather API",
      "description": "Real-time weather data for any city",
      "payment_method": "card",
      "accepted_networks": ["visa"],
      "charge": { "amount": "500", "currency": "usd" },
      "routes": [{ "method": "GET", "path": "/weather", "environment": "production" }]
    }
  ]
}
```

## Next steps

- [Write a gateway adapter for your acquirer](./gateway-adapters.md)
- [Test payment flows in sandbox](./testing.md)
- [View error codes and troubleshooting](./errors.md)
