# Concepts

How MPP card payments work, end to end.

## The protocol in 60 seconds

MPP standardizes HTTP 402 ("Payment Required") for machine-to-machine payments. An agent requests a resource, the server says "pay first," the agent pays, and retries. The payment credential travels in HTTP headers. No checkout pages, no redirects, no human intervention.

## The card payment flow

There are four parties in an MPP card transaction:

- **Agent (client):** The AI agent requesting a paid resource
- **Client Enabler:** Provisions encrypted card tokens (e.g., Visa Intelligent Commerce)
- **MPP Endpoint Service (server):** Returns 402 challenges, decrypts tokens, authorizes payment
- **Server Enabler:** The acquirer's payment gateway that processes the authorization

### Step by step

**Step 1: Agent requests a resource**

```http
GET /v1/acme/weather?city=sf HTTP/1.1
Host: mpp.acquirer.com
```

No payment headers. Just a normal HTTP request.

**Step 2: Server returns a 402 challenge**

```http
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="ch_9fLm3nOpQs",
  method="card",
  intent="charge",
  request="{
    \"amount\": \"500\",
    \"currency\": \"usd\",
    \"description\": \"Acme Weather API\",
    \"methodDetails\": {
      \"acceptedNetworks\": [\"visa\"],
      \"merchantName\": \"Acme Weather API\",
      \"encryptionJwk\": {
        \"kty\": \"RSA\",
        \"n\": \"0vx7agoebGcQSuu...\",
        \"e\": \"AQAB\",
        \"alg\": \"RSA-OAEP-256\",
        \"use\": \"enc\",
        \"kid\": \"key_v1_ep_8xKj2mNpQr\"
      }
    }
  }"
Cache-Control: no-store
```

The challenge contains:
- `id`: Unique, single-use challenge identifier
- `method`: `"card"` (the Visa MPP card spec)
- `intent`: `"charge"` (one-time payment)
- `request.amount`: `"500"` (in cents, so $5.00)
- `request.methodDetails.encryptionJwk`: The server's RSA public key for encrypting the token

**Step 3: Agent provisions an encrypted token**

The agent sends the challenge to its Client Enabler (e.g., Visa Intelligent Commerce). The Client Enabler:

1. Looks up the agent's enrolled card
2. Provisions a single-use network token from the card network
3. Generates a cryptogram (dynamic security data)
4. Encrypts the token + cryptogram as a JWE using the server's RSA public key (RSA-OAEP-256 + AES-256-GCM)
5. Returns the encrypted credential to the agent

The agent never sees the raw card number. The server's public key ensures only the server can decrypt the token.

**Step 4: Agent retries with payment credential**

```http
GET /v1/acme/weather?city=sf HTTP/1.1
Host: mpp.acquirer.com
Authorization: Payment id="ch_9fLm3nOpQs",
  method="card",
  intent="charge",
  payload="{
    \"encryptedPayload\": \"eyJhbGciOiJSU0EtT0FFUC0yNTYi...\",
    \"network\": \"visa\",
    \"panLastFour\": \"4242\",
    \"panExpirationMonth\": \"12\",
    \"panExpirationYear\": \"2028\"
  }"
```

The credential includes:
- `id`: Same challenge ID from step 2 (binds this payment to that challenge)
- `payload.encryptedPayload`: JWE-encrypted network token (only the server can decrypt it)
- `payload.network`: Card network used
- `payload.panLastFour`: Last four digits (for display/logging, not security)

**Step 5: Server decrypts and authorizes**

The server (MPP Endpoint Service):

1. Validates the challenge ID (must be active, unexpired, single-use)
2. Decrypts the JWE using its RSA private key (stored in HSM)
3. Extracts the network token, cryptogram, and expiry
4. Sends an authorization request to the acquirer's gateway
5. Receives approval or decline

**Step 6: Server returns the resource with a receipt**

```http
HTTP/1.1 200 OK
Payment-Receipt: id="ch_9fLm3nOpQs",
  method="card",
  intent="charge",
  receipt="{\"reference\":\"txn_7kMn8oPq\",\"status\":\"success\"}"
Cache-Control: private
Content-Type: application/json

{
  "city": "San Francisco",
  "temp_f": 62,
  "conditions": "Partly cloudy"
}
```

The agent gets the resource it requested, plus a `Payment-Receipt` header confirming the charge.

## Key concepts

### Challenges are single-use

Each challenge ID can be used exactly once. If an agent tries to reuse a challenge ID, the server rejects it with `invalid-challenge` and issues a fresh challenge. This prevents replay attacks.

### Tokens are encrypted end-to-end

The encrypted network token can only be decrypted by the server that issued the challenge (using its RSA private key). The agent, the network, and any intermediaries see only the JWE ciphertext.

### Settlement uses existing card rails

Authorizations flow through the acquirer's standard processing infrastructure. Funds settle on the merchant's normal payout schedule. No new settlement system. No crypto rails. No stablecoin conversion. Just card payments.

### The server never sees the real card number

Visa Intelligent Commerce provisions a network token (a substitute PAN) with a transaction-specific cryptogram. Even after decryption, the server has a network token, not the cardholder's actual card number. This limits PCI scope.

### Body binding prevents tampering

For POST/PUT/PATCH requests, the challenge includes a SHA-256 digest of the request body. The agent must submit the same body when retrying with payment. This prevents an agent from getting a challenge for a cheap request and then swapping in an expensive one.

## How this differs from Stripe's MPP integration

| | Stripe MPP | This service |
|---|---|---|
| **Payment method** | Shared Payment Tokens (SPTs) | Visa encrypted network tokens |
| **Processing** | Through Stripe | Through any acquirer |
| **Settlement** | Stripe balance | Acquirer's standard settlement |
| **Who can use it** | Stripe merchants only | Any merchant on any acquirer |
| **Card spec** | Stripe-proprietary | Visa MPP Card spec (open) |

Both are valid MPP implementations. Stripe's approach is tightly integrated with their platform. This service implements the open Visa card spec so merchants on any acquirer can participate.

## Specification references

- [MPP Protocol](https://mpp.dev/protocol): The core HTTP 402 payment flow
- [Card Network Charge Intent](https://paymentauth.org/draft-card-charge-00): IETF Internet-Draft defining the card payment method
- [Visa Intelligent Commerce](https://developer.visa.com/capabilities/visa-intelligent-commerce): Credential issuer for Visa network tokens
- [Visa Trusted Agent Protocol](https://developer.visa.com/capabilities/trusted-agent-protocol): Optional identity assurance for agents
