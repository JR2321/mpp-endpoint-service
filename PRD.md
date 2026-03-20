# MPP Endpoint-as-a-Service

**Author:** Cuy Sheffield / JR (Research Analyst)
**Status:** Draft
**Last Updated:** 2026-03-20
**Target Release:** TBD

---

## Problem

The Machine Payments Protocol (MPP) launched on March 18, 2026, as an open standard for machine-to-machine payments, co-authored by Stripe and Tempo. Visa released a card-based MPP specification, an SDK (`mpp-card`), and integration with Visa Intelligent Commerce for encrypted network token provisioning.

Right now, the only turnkey path for a merchant to accept MPP card payments is through Stripe. Stripe merchants can add MPP support in a few lines of code using PaymentIntents. This creates two problems:

1. **Merchants on non-Stripe acquirers are locked out of agent commerce.** If you process through Worldpay, Fiserv, Adyen, or any other acquirer, there is no equivalent self-serve tool to make your API endpoints MPP-compatible. You would need to read the spec, implement the 402 challenge/credential flow, manage RSA key pairs, integrate with Visa Intelligent Commerce for token decryption, and wire up authorization through your processor. That is months of work for most engineering teams.

2. **Acquirers risk losing developer-facing merchants to Stripe.** As AI agents become a meaningful source of commerce (Coinbase reports 50M+ machine-to-machine transactions, x402 has processed 75M+), merchants will migrate to whichever processor lets them capture that demand. Stripe just made it trivial for their merchants. Every other acquirer is now behind.

The cost of inaction: acquirers that don't offer MPP compatibility will watch their developer-facing merchants churn to Stripe for agent commerce, exactly as they lost merchants to Stripe for human e-commerce a decade ago.

## Success Criteria

- A developer-facing merchant on any acquirer can turn an existing API endpoint into an MPP card-compatible endpoint in under 30 minutes
- At least 3 acquirers have integrated the service within 6 months of launch
- 100+ merchant endpoints are live and processing MPP card transactions within 6 months
- Zero card data exposure incidents (encrypted tokens are never decrypted outside the acquirer's authorization environment)
- Merchant NPS for onboarding experience exceeds 40

## User Journey

### Merchant Developer (Primary User)

1. Merchant developer visits the service portal and signs up with their acquirer credentials (processor ID, merchant ID, terminal ID)
2. Developer selects "Create MPP Endpoint" and provides:
   - The URL of their existing API endpoint they want to gate behind payment
   - The charge amount and currency per request
   - A display name (shown to the agent/cardholder in the 402 challenge)
3. The service generates:
   - An RSA-2048 key pair (private key stored in the acquirer's HSM/secure enclave; public key embedded in 402 challenges)
   - A unique MPP endpoint URL (e.g., `https://mpp.{acquirer}.com/v1/{merchant}/{endpoint}`)
   - A middleware snippet the developer can alternatively self-host
4. Developer tests the endpoint using the `mppx` CLI or any MPP-compatible agent:
   - `GET /resource` returns `402 Payment Required` with `WWW-Authenticate: Payment` header containing amount, currency, accepted networks (visa), merchant name, and RSA public key
   - Agent's client enabler calls Visa Intelligent Commerce to provision an encrypted network token
   - Agent retries with `Authorization: Payment` header containing the encrypted credential
   - Service decrypts the token, forwards authorization to the acquirer's gateway, and returns the resource with a `Payment-Receipt` header
5. Developer toggles the endpoint from sandbox to production
6. Transactions appear in the merchant's existing acquirer dashboard and settle on their standard schedule

### Acquirer (Platform Customer)

1. Acquirer signs a platform agreement and receives API keys for the service
2. Acquirer configures their gateway connection (authorization endpoint, credentials, supported BINs)
3. Acquirer optionally white-labels the portal under their own domain
4. Merchant endpoints route transactions through the acquirer's existing authorization and settlement infrastructure
5. Acquirer sees aggregate MPP transaction volume, endpoint counts, and error rates in their admin dashboard

## Requirements

### R1: MPP Card Protocol Compliance

The service must fully implement the Visa MPP Card specification as defined in the Card Network Charge Intent (paymentauth.org/draft-card-charge-00) and the `mpp-card` SDK.

**Acceptance Criteria:**
- Given a request to a protected endpoint with no `Authorization: Payment` header, the service returns HTTP 402 with a `WWW-Authenticate: Payment` header containing: `id` (unique challenge ID), `method="card"`, `intent="charge"`, `request` (JSON with amount, currency, description, methodDetails including acceptedNetworks, merchantName, encryptionJwk or jwksUri, and billingRequired flag)
- Given a valid credential with an encrypted network token in the `Authorization: Payment` header, the service decrypts the JWE (RSA-OAEP-256 + AES-256-GCM), extracts the token data and cryptogram, and forwards an authorization request to the acquirer's gateway
- Given a successful authorization, the service returns the upstream resource with a `Payment-Receipt` header
- Given a failed authorization, the service returns HTTP 402 with a fresh challenge and a Problem Details body (RFC 9457) with type `verification-failed`
- Given a duplicate challenge ID, the service rejects the credential and returns a fresh challenge with type `invalid-challenge`
- All responses follow MPP status code conventions: 402 for payment issues, 200 for success, 403 for policy denial after valid payment

### R2: Self-Serve Endpoint Configuration

Merchants must be able to create and manage MPP endpoints without acquirer involvement.

**Acceptance Criteria:**
- Given a merchant developer with valid acquirer credentials, they can create a new MPP endpoint in under 5 minutes via the portal or API
- Given an endpoint configuration (upstream URL, amount, currency, merchant name), the service provisions an RSA-2048 key pair and generates a unique MPP endpoint URL
- Given a created endpoint, the merchant can update the charge amount, description, and upstream URL without downtime
- Given a created endpoint, the merchant can toggle between sandbox (test credentials, no real charges) and production mode
- Given a deleted endpoint, all associated keys are rotated and the URL returns 404 within 60 seconds

### R3: RSA Key Management

The service must handle RSA key generation, storage, rotation, and usage per the MPP card spec.

**Acceptance Criteria:**
- Given endpoint creation, the service generates an RSA-2048 key pair
- Given a 402 challenge, the public key is included as `encryptionJwk` (or served via `jwksUri` with `kid`) per the spec
- Given a credential, the private key decrypts the JWE-encrypted network token (RSA-OAEP-256 + AES-256-GCM)
- Private keys are stored in HSM or secure enclave; never exposed via API, logs, or error messages
- Keys can be rotated per-endpoint without service interruption (old key remains valid for in-flight transactions up to 5 minutes after rotation)

### R4: Gateway Abstraction Layer

The service must support multiple acquirer gateways through a pluggable adapter pattern.

**Acceptance Criteria:**
- Given a decrypted network token (PAN token, cryptogram, expiry, billing data), the service constructs an authorization request compatible with the configured acquirer gateway
- Given Worldpay as the configured gateway, the adapter maps token data to Worldpay's authorization API format
- Given Fiserv as the configured gateway, the adapter maps token data to Fiserv's authorization API format
- Given a new acquirer integration, a developer can implement a gateway adapter by conforming to a defined interface: `charge({ token, amount, currency, idempotencyKey }) => { reference, status }`
- Gateway timeouts (>5s) return a 402 with a fresh challenge; the merchant is not charged

### R5: Proxy Mode (Hosted Endpoints)

The service must operate as a reverse proxy, sitting between agents and the merchant's existing API.

**Acceptance Criteria:**
- Given a configured upstream URL, the service proxies the original request (method, headers, body) to the merchant's API after successful payment
- Given a request with a body (POST, PUT, PATCH), the service binds the challenge to the request body via digest (SHA-256, per RFC 9530) to prevent body modification after challenge issuance
- Given upstream latency >10s, the service returns 504 to the agent (payment is not captured if the upstream fails)
- Given an upstream 4xx or 5xx response, the service returns the upstream error to the agent (payment is captured only on upstream 2xx)
- The service preserves the `Idempotency-Key` header for safe retries on non-idempotent methods

### R6: Middleware Mode (Self-Hosted)

As an alternative to proxy mode, the service must offer a middleware library merchants can embed in their own servers.

**Acceptance Criteria:**
- Given an npm package (`@mpp-endpoint/middleware`), a merchant can add MPP card payment gating to any Fetch API-compatible server (Hono, Next.js, Bun, Cloudflare Workers) in under 20 lines of code
- Given Express or Node.js HTTP servers, a `toNodeListener` adapter is provided
- The middleware handles: challenge generation, credential parsing, JWE decryption, gateway authorization, and receipt attachment
- The middleware calls the acquirer's gateway through a configurable adapter (same interface as R4)
- Middleware mode does not require the merchant to manage RSA keys directly; keys can be fetched from the service's key management API

### R7: Sandbox and Testing

**Acceptance Criteria:**
- Given sandbox mode, the service returns valid 402 challenges but processes payments against a test gateway (no real charges)
- Given the `mppx` CLI (`npx mppx <endpoint-url>`), a developer can test the full 402 flow end-to-end
- Given a sandbox endpoint, the service logs full request/response pairs (excluding encrypted credentials) for debugging
- Given a test card ID, the service simulates successful and failed authorizations

### R8: Discovery Endpoint

Each merchant must expose a machine-readable catalog of their MPP endpoints.

**Acceptance Criteria:**
- Given a `GET /discover` request to the merchant's MPP base URL, the service returns a JSON catalog listing all active endpoints with: service name, description, payment method (card), accepted networks, charge amount/currency, and endpoint paths
- The catalog distinguishes sandbox and production endpoints
- The catalog conforms to the MPP service discovery convention

## Scope

### In Scope
- MPP card charge intent (one-time payments via Visa network tokens)
- Self-serve merchant portal and API for endpoint management
- Hosted proxy mode (service sits between agent and merchant API)
- Middleware mode (npm package for self-hosted integration)
- RSA key management (generation, storage, rotation)
- Gateway adapter interface with initial support for 2-3 major acquirers
- Sandbox/testing environment
- Service discovery endpoint (`/discover`)
- Transaction logging and basic analytics (volume, success rate, latency)

### Out of Scope (Future)
- **Stablecoin/Tempo payments:** MPP supports Tempo chain natively, but this product focuses on card rails to serve acquirers. Stablecoin support is a natural Phase 2.
- **Stripe SPT method:** Out of scope because Stripe merchants already have native MPP support. This product exists specifically for non-Stripe acquirers.
- **Session intent (streaming payments):** The card spec currently supports charge only. Session-based billing (e.g., per-token for LLM APIs) is a future intent.
- **Multi-network support beyond Visa:** The spec is network-agnostic, but Visa is the only network with an MPP credential issuer (Visa Intelligent Commerce) today. Mastercard, Amex, Discover support can be added as those networks build MPP credential issuers.
- **Merchant billing/invoicing:** How acquirers charge merchants for using this service is out of scope. Each acquirer sets their own pricing.
- **PCI DSS certification for the service itself:** The service handles encrypted network tokens (JWE), not raw card data. PCI scope is limited. However, a formal PCI assessment will be needed before production launch, scoped separately.

## Edge Cases

- **Agent sends credential for wrong challenge ID:** Return 402 with fresh challenge and `invalid-challenge` problem type. Do not attempt authorization.
- **Encrypted token decryption fails (corrupted JWE):** Return 402 with `malformed-credential`. Log the failure (without the credential itself) for debugging.
- **Acquirer gateway returns decline:** Return 402 with `verification-failed` and include the decline reason in the problem detail (e.g., "insufficient funds", "do not honor"). Include `Retry-After` header if the decline is temporary.
- **Acquirer gateway is unreachable:** Return 402 with `verification-failed` and detail "payment processor unavailable". Set `Retry-After: 30`. Do not cache the failure for the endpoint.
- **Merchant upstream API is down:** If payment was not yet authorized, return 402 with fresh challenge. If payment was authorized but upstream fails, initiate automatic void/reversal and return 502 to the agent.
- **Challenge expires:** Challenges expire after 5 minutes. Credentials referencing expired challenges receive 402 with `invalid-challenge` and a fresh challenge.
- **Concurrent requests with same Idempotency-Key:** Process the first, return the cached result for subsequent requests within a 24-hour window.
- **Key rotation during in-flight transaction:** Old private key remains valid for 5 minutes after rotation. Credentials encrypted with the old key are still decryptable.
- **Agent sends billing address when not required:** Accept and ignore. Do not reject.
- **Amount is zero or negative in endpoint config:** Reject at configuration time with validation error. MPP charges must be positive.

## Technical Requirements

- **Latency:** End-to-end (challenge issuance through receipt) must complete in under 3 seconds, excluding upstream API latency. Challenge-only responses (402) must return in under 100ms.
- **Scale:** Support 10,000 endpoints at launch. Design for 1M endpoints and 100M transactions/month at steady state.
- **Availability:** 99.95% uptime SLA for the proxy service. Middleware mode availability depends on the merchant's infrastructure.
- **Security:**
  - TLS 1.2+ required for all connections (TLS 1.3 preferred per MPP spec)
  - RSA private keys stored in HSM (AWS CloudHSM, Azure Dedicated HSM, or equivalent)
  - Payment credentials must never appear in logs, error messages, or analytics
  - Challenge IDs must be cryptographically random and single-use
  - All 402 responses include `Cache-Control: no-store`
  - All 200 responses with `Payment-Receipt` include `Cache-Control: private`
- **Compliance:** PCI DSS scope assessment required before production. The service handles encrypted tokens (not raw PANs), which limits but does not eliminate PCI obligations.
- **Idempotency:** Re-processing a credential with the same challenge ID must not create duplicate authorizations. The gateway adapter must pass `idempotencyKey` derived from the challenge ID.
- **Monitoring:** Per-endpoint metrics: request volume, 402 rate, authorization success rate, average latency, error breakdown by type.

## Technical Context

- The MPP card spec is defined at paymentauth.org/draft-card-charge-00 (IETF Internet-Draft, March 2026)
- The `mpp-card` npm package provides reference client and server implementations
- Visa Intelligent Commerce (developer.visa.com/capabilities/visa-intelligent-commerce) is the credential issuer for Visa network tokens
- Visa Trusted Agent Protocol (developer.visa.com/capabilities/trusted-agent-protocol) provides identity assurance headers that agents can include
- The existing `mpp-card-servers` reference implementation (github.com/xnovahunter7/mpp-card-servers) demonstrates the pattern of proxying requests and charging per-call via card
- Stripe's MPP integration uses PaymentIntents and Shared Payment Tokens (SPTs), a different approach from the Visa card spec. This product implements the Visa card spec directly, which settles through acquirer card rails rather than Stripe's platform
- The gateway adapter interface mirrors the `mpp-card` SDK's server gateway: `charge({ token, amount, currency, idempotencyKey }) => { reference, status }`

## Open Questions

- [OPEN] Which acquirers should we target for initial gateway adapters? Worldpay and Fiserv seem like the highest-impact starting points based on market share among developer-facing merchants.
- [OPEN] Should the hosted proxy be multi-tenant SaaS, or should we offer single-tenant deployment within the acquirer's infrastructure? Security and compliance implications differ significantly.
- [OPEN] What is the pricing model for acquirers? Per-endpoint monthly fee, per-transaction basis points, or platform licensing? This affects the business case for acquirer adoption.
- [OPEN] Do we need to build a credential issuer integration for the client side (agent side), or do we assume agents will use Visa Intelligent Commerce directly? The MPP card spec is PSP-agnostic on the client side.
- [OPEN] How do we handle Visa Intelligent Commerce onboarding for merchants? Do merchants need their own VIC credentials, or can the acquirer provide these as part of their platform?
- [OPEN] Should we pursue PCI P2PE (Point-to-Point Encryption) certification given that we only handle encrypted tokens? This could significantly reduce the merchant's PCI burden.

## References

- MPP Protocol Overview: https://mpp.dev/protocol
- MPP Card Payment Method: https://mpp.dev/payment-methods/card
- MPP Card Charge Intent: https://mpp.dev/payment-methods/card/charge
- Card Network Charge Intent Spec (IETF): https://paymentauth.org/draft-card-charge-00
- Visa Intelligent Commerce: https://developer.visa.com/capabilities/visa-intelligent-commerce
- Visa Trusted Agent Protocol: https://developer.visa.com/capabilities/trusted-agent-protocol
- Stripe MPP Blog Post: https://stripe.com/blog/machine-payments-protocol
- Stripe MPP Docs: https://docs.stripe.com/payments/machine/mpp
- `mpp-card` SDK: https://www.npmjs.com/package/mpp-card
- `mpp-card-servers` Reference Implementation: https://github.com/xnovahunter7/mpp-card-servers
- Visa Press Release (March 18, 2026): https://corporate.visa.com/en/sites/visa-perspectives/innovation/visa-card-specification-sdk-for-machine-payments-protocol.html
- PYMNTS Coverage: https://www.pymnts.com/visa/2026/visa-scales-agentic-commerce-through-stripe-protocol-collaboration/
- Fortune Coverage: https://fortune.com/2026/03/18/stripe-tempo-paradigm-mpp-ai-payments-protocol/
