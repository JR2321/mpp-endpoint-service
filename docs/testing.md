# Testing & Sandbox

Test the full MPP payment flow without real charges.

## Sandbox mode

Every endpoint starts in sandbox mode. Sandbox endpoints:
- Return real 402 challenges with valid structure
- Process payments against a test gateway (no real card charges)
- Log full request/response details for debugging
- Support test card IDs for simulating success and failure scenarios

## Quick test with the CLI

The fastest way to test: use the `mppx` CLI.

```bash
# Install
npm install -g mppx

# Create a test account (funded with test tokens)
npx mppx account create

# Hit your sandbox endpoint
npx mppx https://mpp.acquirer.com/v1/acme/weather?city=sf
```

```json
{
  "city": "San Francisco",
  "temp_f": 62,
  "conditions": "Partly cloudy"
}
```

The CLI handles the full 402 challenge/credential flow automatically.

## Test step by step

### Step 1: Verify the 402 challenge

```bash
curl -i https://mpp.acquirer.com/v1/acme/weather?city=sf
```

Check that:
- Status is `402`
- `WWW-Authenticate: Payment` header is present
- `method="card"` and `intent="charge"` are set
- `amount` and `currency` match your endpoint config
- `encryptionJwk` or `jwksUri` is present
- `Cache-Control: no-store` is present

### Step 2: Verify the payment flow

```bash
npx mppx https://mpp.acquirer.com/v1/acme/weather?city=sf --verbose
```

Verbose mode shows each step:

```
→ GET https://mpp.acquirer.com/v1/acme/weather?city=sf
← 402 Payment Required
  Challenge: ch_9fLm3nOpQs
  Amount: $5.00 USD
  Method: card (visa)

→ Provisioning test card token...
  Encrypting with RSA-OAEP-256

→ GET https://mpp.acquirer.com/v1/acme/weather?city=sf
  Authorization: Payment id="ch_9fLm3nOpQs" method="card" ...
← 200 OK
  Payment-Receipt: txn_7kMn8oPq (success)
  Latency: 230ms

{"city":"San Francisco","temp_f":62,"conditions":"Partly cloudy"}
```

### Step 3: Check the transaction log

```bash
curl "https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr/transactions?limit=1" \
  -H "Authorization: Bearer mpp_test_sk_abc123"
```

```json
{
  "data": [
    {
      "id": "txn_7kMn8oPq",
      "challenge_id": "ch_9fLm3nOpQs",
      "amount": "500",
      "currency": "usd",
      "status": "success",
      "network": "visa",
      "pan_last_four": "4242",
      "environment": "sandbox",
      "latency_ms": 230,
      "created_at": "2026-03-20T01:00:05Z"
    }
  ]
}
```

## Test card IDs

Use these card IDs in sandbox mode to simulate different outcomes:

| Card ID | Behavior |
|---------|----------|
| `card_test_success` | Approved. Returns `status: "success"`. |
| `card_test_decline_funds` | Declined: insufficient funds. Decline code `"51"`. |
| `card_test_decline_honor` | Declined: do not honor. Decline code `"05"`. |
| `card_test_decline_expired` | Declined: expired card. Decline code `"54"`. |
| `card_test_error_timeout` | Simulates gateway timeout (>5s). Returns fresh 402. |
| `card_test_error_network` | Simulates network error. Returns `verification-failed`. |

### Using test cards with the CLI

```bash
npx mppx --card card_test_decline_funds https://mpp.acquirer.com/v1/acme/weather?city=sf
```

```
← 402 Payment Required
  type: verification-failed
  detail: Card declined: insufficient funds.
  Retry-After: 30
```

## Testing POST endpoints

For endpoints that accept POST requests, verify body binding works:

```bash
# Step 1: Send POST, get challenge with body digest
curl -i -X POST https://mpp.acquirer.com/v1/acme/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "hello", "target": "es"}'
```

```http
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="ch_abc123",
  method="card",
  intent="charge",
  digest="sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:",
  request="..."
```

```bash
# Step 2: Retry with the SAME body + payment credential
npx mppx -X POST https://mpp.acquirer.com/v1/acme/translate \
  -d '{"text": "hello", "target": "es"}'
```

If the body differs from the original request, the service rejects the credential with `invalid-challenge`.

## Testing the discovery endpoint

```bash
curl https://mpp.acquirer.com/v1/acme/discover
```

Verify:
- All active endpoints are listed
- Sandbox and production endpoints are distinguished
- Amounts and currencies are correct
- Routes include the correct HTTP methods and paths

## Sandbox request logs

Sandbox endpoints log full request/response details (excluding encrypted credentials). View them via the API:

```bash
curl "https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr/logs?limit=5" \
  -H "Authorization: Bearer mpp_test_sk_abc123"
```

```json
{
  "data": [
    {
      "timestamp": "2026-03-20T01:00:05Z",
      "challenge_id": "ch_9fLm3nOpQs",
      "phase": "challenge",
      "request": {
        "method": "GET",
        "path": "/v1/acme/weather?city=sf",
        "headers": { "User-Agent": "mppx/1.0" }
      },
      "response": {
        "status": 402,
        "challenge_amount": "500",
        "challenge_currency": "usd"
      }
    },
    {
      "timestamp": "2026-03-20T01:00:05Z",
      "challenge_id": "ch_9fLm3nOpQs",
      "phase": "payment",
      "gateway_status": "success",
      "gateway_reference": "txn_7kMn8oPq",
      "upstream_status": 200,
      "latency_ms": 230
    }
  ]
}
```

Logs are retained for 7 days in sandbox mode.

## Checklist before going live

Before switching an endpoint to production:

- [ ] 402 challenge returns correct amount, currency, and merchant name
- [ ] Successful payment returns the upstream resource with a `Payment-Receipt` header
- [ ] Declined payment returns a fresh 402 with problem details
- [ ] POST endpoints enforce body binding (modified body is rejected)
- [ ] Discovery endpoint lists all your services correctly
- [ ] Upstream errors (4xx/5xx) do not result in captured payments
- [ ] Gateway timeout does not result in a captured payment
- [ ] Transaction logs show expected volume and success rates

Once everything checks out:

```bash
curl -X PATCH https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr \
  -H "Authorization: Bearer mpp_live_sk_xyz789" \
  -H "Content-Type: application/json" \
  -d '{"status": "production"}'
```
