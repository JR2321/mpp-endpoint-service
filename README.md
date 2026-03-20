# MPP Endpoint-as-a-Service

Turn any API into an MPP card-compatible endpoint. Built for acquirers who want to compete with Stripe's MPP offering.

## What is this?

The [Machine Payments Protocol](https://mpp.dev) (MPP) launched on March 18, 2026 as an open standard for machine-to-machine payments. Stripe merchants can accept MPP payments in a few lines of code. **This project builds the equivalent capability for merchants on any acquirer.**

An AI agent hits your endpoint, gets a 402 payment challenge, pays with an encrypted Visa network token, and receives the resource. Your API stays exactly as it is. We handle the protocol.

## Quick start

```bash
# Clone and install
git clone https://github.com/JR2321/mpp-endpoint-service.git
cd mpp-endpoint-service
npm install

# Start the server
npx tsx src/index.ts
```

### Create an endpoint

```bash
curl -X POST http://localhost:3000/v1/endpoints \
  -H "Content-Type: application/json" \
  -d '{
    "upstream_url": "https://httpbin.org/get",
    "amount": "500",
    "currency": "usd",
    "merchant_name": "My API"
  }'
```

### Test the MPP flow

```bash
# Get a 402 challenge
curl -i http://localhost:3000/v1/mpp/<endpoint_id>

# Full flow with mppx CLI
npx mppx http://localhost:3000/v1/mpp/<endpoint_id>
```

## Architecture

```
Agent ──► MPP Endpoint Service ──► Your API
              │
              ├── 402 Challenge (amount, RSA public key)
              ├── Decrypt JWE token (RSA-OAEP-256 + AES-256-GCM)
              ├── Authorize via acquirer gateway
              └── Proxy request + attach Payment-Receipt
```

## Features (v0.1.0)

- **Full MPP card protocol compliance** — 402 challenges, JWE decryption, gateway auth, receipts
- **Endpoint CRUD API** — Create, list, update, delete payment-gated endpoints
- **RSA key management** — Auto-generated key pairs, rotation with grace period
- **Pluggable gateway adapters** — Sandbox included, bring your own acquirer
- **Reverse proxy** — Sits in front of your API, zero code changes
- **Discovery endpoint** — Machine-readable service catalog at `/v1/discover`
- **Sandbox mode** — Test cards for success, decline, and error scenarios
- **Body binding** — SHA-256 digest prevents POST body tampering

## Test cards (sandbox mode)

| Card ID | Result |
|---------|--------|
| `card_test_success` | Approved |
| `card_test_decline_funds` | Declined: insufficient funds |
| `card_test_decline_honor` | Declined: do not honor |
| `card_test_decline_expired` | Declined: expired card |
| `card_test_error_timeout` | Gateway timeout |
| `card_test_error_network` | Network error |

## Running tests

```bash
npx tsx --test src/**/*.test.ts
```

**21 tests** covering crypto operations, endpoint management, the full 402 payment flow, challenge replay protection, and decline handling.

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

## Documents

- [**PRD.md**](./PRD.md) — Product Requirements Document
- [**docs/**](./docs/) — Developer documentation (Stripe-quality)
  - [Quickstart: Proxy mode](./docs/quickstart-proxy.md)
  - [Quickstart: Middleware mode](./docs/quickstart-middleware.md)
  - [API Reference](./docs/api-reference.md)
  - [Gateway Adapters](./docs/gateway-adapters.md)
  - [Error Reference](./docs/errors.md)
  - [Testing & Sandbox](./docs/testing.md)
  - [Concepts](./docs/concepts.md)

## Key references

- [MPP Protocol](https://mpp.dev)
- [Visa MPP Card Spec](https://paymentauth.org/draft-card-charge-00)
- [mpp-card SDK](https://www.npmjs.com/package/mpp-card)
- [Visa Intelligent Commerce](https://developer.visa.com/capabilities/visa-intelligent-commerce)

## License

MIT
