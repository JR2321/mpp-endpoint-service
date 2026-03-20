# MPP Endpoint-as-a-Service

Turn any API into an MPP card-compatible endpoint. Built for acquirers who want to offer their merchants MPP support without requiring them to migrate to Stripe.

## What is this?

The [Machine Payments Protocol](https://mpp.dev) (MPP) launched as an open standard for machine-to-machine payments. Stripe merchants can accept MPP payments in a few lines of code. **This project builds the equivalent capability for merchants on any acquirer** (Worldpay, Fiserv, Adyen, etc.).

An AI agent hits your endpoint, gets a 402 payment challenge, pays with an encrypted Visa network token, and receives the resource. Your API stays exactly as it is. We handle the protocol.

## Two integration modes

**Proxy mode** (hosted): Zero code changes. The service sits in front of your API.

```bash
# Create an endpoint
curl -X POST http://localhost:3000/v1/endpoints \
  -H "Content-Type: application/json" \
  -d '{
    "upstream_url": "https://api.example.com/weather",
    "amount": "500",
    "currency": "usd",
    "merchant_name": "Weather API"
  }'

# Test the MPP flow
npx mppx http://localhost:3000/v1/mpp/<endpoint_id>
```

**Middleware mode** (embedded): Drop into your existing server.

```typescript
import { Hono } from 'hono'
import { mppCardMiddleware, sandboxGateway } from 'mpp-endpoint-service/middleware'

const app = new Hono()
const mpp = mppCardMiddleware({
  amount: '500',
  currency: 'usd',
  merchantName: 'Weather API',
  gateway: sandboxGateway,
})

app.get('/weather', async (c) => {
  const res = await mpp(c.req.raw, async () => {
    return c.json({ temp: 72, city: 'SF' })
  })
  return res
})
```

## Quick start

```bash
git clone https://github.com/JR2321/mpp-endpoint-service.git
cd mpp-endpoint-service
npm install
npx tsx src/index.ts
```

## Features (v1)

- Full MPP card protocol compliance (402 challenges, JWE decryption, gateway auth, receipts)
- Self-serve endpoint CRUD API (create an MPP endpoint in under 5 minutes)
- RSA key management with rotation and grace period for old keys
- Pluggable gateway adapters (sandbox built-in, Worldpay and Fiserv stubs included)
- Reverse proxy mode (sits in front of your API, zero code changes)
- Middleware mode (embed in Hono, Express, or any Fetch API server)
- Dynamic pricing (static amount, callback function, or webhook URL)
- Sandbox with 6 test card IDs for success, decline, and error scenarios
- Body binding via SHA-256 digest to prevent POST body tampering
- Discovery endpoint for machine-readable service catalog
- Transaction logging with status, latency, and gateway references
- Docker-ready

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Agent / Client                         │
│  1. GET /v1/mpp/:id → 402 + Challenge (amount, RSA pub key) │
│  2. Encrypt network token (JWE RSA-OAEP-256 + AES-256-GCM)  │
│  3. Retry with Authorization: Payment ...                     │
└──────────────────────┬───────────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │  MPP Endpoint Service    │
          │                          │
          │  • Decrypt JWE token     │
          │  • Authorize via gateway │
          │  • Proxy to upstream     │
          │  • Return + Receipt      │
          └──────────┬───────────────┘
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
  Sandbox       Worldpay        Fiserv
  (built-in)    (stub)          (stub)
```

## Test cards (sandbox mode)

| Card ID | Result |
|---------|--------|
| `card_test_success` | Approved |
| `card_test_decline_funds` | Declined: insufficient funds |
| `card_test_decline_honor` | Declined: do not honor |
| `card_test_decline_expired` | Declined: expired card |
| `card_test_error_timeout` | Gateway timeout |
| `card_test_error_network` | Network error |

## Dynamic pricing

Three options for charge amounts:

**Static** (default): Set `amount` on the endpoint. Same price for every request.

**Function callback** (middleware mode): Pass a function that returns the amount based on the request.

```typescript
mppCardMiddleware({
  amount: (req) => {
    const url = new URL(req.url)
    return url.pathname.includes('/premium') ? '1000' : '100'
  },
  // ...
})
```

**Webhook** (proxy mode): Set `pricing_webhook_url` on the endpoint. Before issuing the 402 challenge, the proxy POSTs request details and expects `{ "amount": "500" }` back.

```bash
curl -X PATCH http://localhost:3000/v1/endpoints/ep_abc \
  -H "Content-Type: application/json" \
  -d '{ "pricing_webhook_url": "https://api.example.com/pricing" }'
```

## Gateway adapters

| Adapter | Status | Notes |
|---------|--------|-------|
| `sandbox` | Production-ready | Built-in test adapter. No credentials needed. |
| `worldpay` | Stub | Scaffolded. Requires Worldpay XML Direct credentials. |
| `fiserv` | Stub | Scaffolded. Requires Fiserv Commerce Hub API key + HMAC secret. |

To implement a new gateway, export an object implementing `GatewayAdapter`:

```typescript
interface GatewayAdapter {
  charge(params: ChargeParams): Promise<ChargeResult>
  void?(params: { reference: string }): Promise<{ status: 'voided' | 'error'; reference: string }>
}
```

## Running tests

```bash
npx tsx --test src/crypto.test.ts src/integration.test.ts src/middleware.test.ts
```

**23 tests** across 3 suites covering crypto operations, endpoint management, the full 402 payment flow, middleware mode, dynamic pricing, challenge replay protection, and decline handling.

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/endpoints` | Create an endpoint |
| `GET` | `/v1/endpoints` | List endpoints |
| `GET` | `/v1/endpoints/:id` | Get endpoint details |
| `PATCH` | `/v1/endpoints/:id` | Update endpoint |
| `DELETE` | `/v1/endpoints/:id` | Delete endpoint |
| `POST` | `/v1/endpoints/:id/keys/rotate` | Rotate encryption keys |
| `GET` | `/.well-known/jwks/:id` | Public key (JWKS) |
| `GET` | `/v1/endpoints/:id/transactions` | List transactions |
| `GET` | `/v1/discover` | Service catalog |
| `ANY` | `/v1/mpp/:id` | MPP payment-gated proxy |

## Docker

```bash
docker build -t mpp-endpoint-service .
docker run -p 3000:3000 mpp-endpoint-service
```

## Documents

- [PRD.md](./PRD.md) - Product Requirements Document
- [docs/](./docs/) - Developer documentation
  - [Quickstart: Proxy mode](./docs/quickstart-proxy.md)
  - [Quickstart: Middleware mode](./docs/quickstart-middleware.md)
  - [API Reference](./docs/api-reference.md)
  - [Gateway Adapters](./docs/gateway-adapters.md)
  - [Error Reference](./docs/errors.md)
  - [Testing & Sandbox](./docs/testing.md)

## Key references

- [MPP Protocol](https://mpp.dev)
- [Visa MPP Card Spec](https://paymentauth.org/draft-card-charge-00)
- [mppx SDK](https://www.npmjs.com/package/mppx)

## License

MIT
