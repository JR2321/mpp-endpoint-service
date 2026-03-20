# Quickstart: Proxy Mode

Gate your existing API behind MPP card payments with zero code changes.

## 1. Create an endpoint

```bash
curl -X POST https://api.mpp-endpoint.com/v1/endpoints \
  -H "Authorization: Bearer mpp_test_sk_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "upstream_url": "https://api.acme.com/weather",
    "amount": "500",
    "currency": "usd",
    "merchant_name": "Acme Weather API",
    "accepted_networks": ["visa"]
  }'
```

Response:

```json
{
  "id": "ep_8xKj2mNpQr",
  "status": "sandbox",
  "endpoint_url": "https://mpp.acquirer.com/v1/acme/weather",
  "upstream_url": "https://api.acme.com/weather",
  "amount": "500",
  "currency": "usd",
  "merchant_name": "Acme Weather API",
  "accepted_networks": ["visa"],
  "created_at": "2026-03-20T01:00:00Z",
  "keys": {
    "jwks_uri": "https://mpp.acquirer.com/.well-known/jwks/ep_8xKj2mNpQr",
    "kid": "key_v1_ep_8xKj2mNpQr"
  }
}
```

That's it. Your MPP endpoint is live in sandbox mode.

## 2. Test it

Make a request without payment credentials. You'll get a 402 challenge:

```bash
curl -i https://mpp.acquirer.com/v1/acme/weather?city=sf
```

```http
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="ch_9fLm3nOpQs",
  method="card",
  intent="charge",
  request="{\"amount\":\"500\",\"currency\":\"usd\",\"description\":\"Acme Weather API\",\"methodDetails\":{\"acceptedNetworks\":[\"visa\"],\"merchantName\":\"Acme Weather API\",\"encryptionJwk\":{\"kty\":\"RSA\",\"n\":\"0vx7...\",\"e\":\"AQAB\",\"alg\":\"RSA-OAEP-256\",\"use\":\"enc\",\"kid\":\"key_v1_ep_8xKj2mNpQr\"}}}"
Cache-Control: no-store
Content-Type: application/json

{
  "type": "https://paymentauth.org/problems/payment-required",
  "title": "Payment Required",
  "status": 402,
  "detail": "This resource requires a card payment of $5.00 USD."
}
```

Now test the full payment flow using the `mppx` CLI:

```bash
npx mppx https://mpp.acquirer.com/v1/acme/weather?city=sf
```

```json
{
  "city": "San Francisco",
  "temp_f": 62,
  "conditions": "Partly cloudy"
}
```

The CLI handles the 402 challenge, provisions a test card token, and retries with payment credentials automatically.

## 3. Go live

Toggle your endpoint from sandbox to production:

```bash
curl -X PATCH https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr \
  -H "Authorization: Bearer mpp_live_sk_xyz789" \
  -H "Content-Type: application/json" \
  -d '{"status": "production"}'
```

```json
{
  "id": "ep_8xKj2mNpQr",
  "status": "production",
  "endpoint_url": "https://mpp.acquirer.com/v1/acme/weather",
  "amount": "500",
  "currency": "usd"
}
```

Production endpoints charge real cards and settle through your acquirer on your standard payout schedule.

## What just happened

1. You created an endpoint pointing at your existing API
2. The service generated an RSA-2048 key pair. The public key goes in 402 challenges. The private key stays in an HSM.
3. When an agent hits your endpoint, the service returns a 402 challenge with the amount, currency, and encryption key
4. The agent's client (using Visa Intelligent Commerce) provisions an encrypted network token and retries
5. The service decrypts the token, authorizes the charge through your acquirer, and proxies the request to your API
6. The agent gets the response plus a payment receipt

## Configure your endpoint

### Update pricing

```bash
curl -X PATCH https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr \
  -H "Authorization: Bearer mpp_test_sk_abc123" \
  -H "Content-Type: application/json" \
  -d '{"amount": "1000", "description": "Premium weather data"}'
```

Updates take effect immediately. In-flight transactions complete at the old price.

### Multiple endpoints

Create as many endpoints as you need. Each gets its own URL, pricing, and key pair:

```bash
curl -X POST https://api.mpp-endpoint.com/v1/endpoints \
  -H "Authorization: Bearer mpp_test_sk_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "upstream_url": "https://api.acme.com/forecast",
    "amount": "1500",
    "currency": "usd",
    "merchant_name": "Acme Forecast API"
  }'
```

### POST endpoints with request body binding

For endpoints that accept POST requests, the service binds the payment challenge to the request body using a SHA-256 digest. This prevents the agent from modifying the body after receiving the challenge.

```bash
curl -X POST https://mpp.acquirer.com/v1/acme/translate \
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

The agent must submit the same body when retrying with the payment credential.

### Delete an endpoint

```bash
curl -X DELETE https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr \
  -H "Authorization: Bearer mpp_test_sk_abc123"
```

```http
HTTP/1.1 204 No Content
```

Keys are rotated and the URL returns 404 within 60 seconds.

## Discovery

Every merchant gets a `/discover` endpoint that lists all active MPP endpoints:

```bash
curl https://mpp.acquirer.com/v1/acme/discover
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
      "routes": [
        {
          "method": "GET",
          "path": "/v1/acme/weather",
          "environment": "production"
        }
      ]
    },
    {
      "id": "forecast",
      "name": "Acme Forecast API",
      "charge": { "amount": "1500", "currency": "usd" },
      "routes": [
        {
          "method": "GET",
          "path": "/v1/acme/forecast",
          "environment": "production"
        }
      ]
    }
  ]
}
```

Agents use this to find what's available and how much it costs before making requests.

## Next steps

- [Test payment flows in sandbox](./testing.md)
- [View error codes and troubleshooting](./errors.md)
- [Understand how MPP card payments work](./concepts.md)
