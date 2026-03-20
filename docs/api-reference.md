# API Reference

Base URL: `https://api.mpp-endpoint.com/v1`

All requests require an API key in the `Authorization` header:

```
Authorization: Bearer mpp_test_sk_abc123
```

Use `mpp_test_sk_*` keys for sandbox. Use `mpp_live_sk_*` keys for production.

---

## Endpoints

### Create an endpoint

```
POST /v1/endpoints
```

```bash
curl -X POST https://api.mpp-endpoint.com/v1/endpoints \
  -H "Authorization: Bearer mpp_test_sk_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "upstream_url": "https://api.acme.com/weather",
    "upstream_method": "GET",
    "amount": "500",
    "currency": "usd",
    "merchant_name": "Acme Weather API",
    "description": "Real-time weather data",
    "accepted_networks": ["visa"],
    "billing_required": false
  }'
```

**Parameters**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `upstream_url` | `string` | Yes | The URL of your existing API endpoint |
| `upstream_method` | `string` | No | HTTP method to proxy. Default: matches incoming request method |
| `amount` | `string` | Yes | Charge per request in smallest currency unit (e.g., `"500"` = $5.00) |
| `currency` | `string` | Yes | ISO 4217 currency code |
| `merchant_name` | `string` | Yes | Display name shown to agents in the 402 challenge |
| `description` | `string` | No | Human-readable payment description |
| `accepted_networks` | `string[]` | No | Card networks to accept. Default: `["visa"]` |
| `billing_required` | `boolean` | No | Request billing address. Default: `false` |
| `upstream_headers` | `object` | No | Static headers to add to upstream requests (e.g., API keys) |

**Response: 201 Created**

```json
{
  "id": "ep_8xKj2mNpQr",
  "status": "sandbox",
  "endpoint_url": "https://mpp.acquirer.com/v1/acme/weather",
  "upstream_url": "https://api.acme.com/weather",
  "amount": "500",
  "currency": "usd",
  "merchant_name": "Acme Weather API",
  "description": "Real-time weather data",
  "accepted_networks": ["visa"],
  "billing_required": false,
  "keys": {
    "jwks_uri": "https://mpp.acquirer.com/.well-known/jwks/ep_8xKj2mNpQr",
    "kid": "key_v1_ep_8xKj2mNpQr"
  },
  "created_at": "2026-03-20T01:00:00Z",
  "updated_at": "2026-03-20T01:00:00Z"
}
```

---

### Get an endpoint

```
GET /v1/endpoints/{endpoint_id}
```

```bash
curl https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr \
  -H "Authorization: Bearer mpp_test_sk_abc123"
```

**Response: 200 OK**

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
  "keys": {
    "jwks_uri": "https://mpp.acquirer.com/.well-known/jwks/ep_8xKj2mNpQr",
    "kid": "key_v1_ep_8xKj2mNpQr"
  },
  "metrics": {
    "total_requests": 1420,
    "successful_payments": 1380,
    "declined_payments": 32,
    "errors": 8,
    "avg_latency_ms": 245
  },
  "created_at": "2026-03-20T01:00:00Z",
  "updated_at": "2026-03-20T12:00:00Z"
}
```

---

### List endpoints

```
GET /v1/endpoints
```

```bash
curl https://api.mpp-endpoint.com/v1/endpoints \
  -H "Authorization: Bearer mpp_test_sk_abc123"
```

**Query parameters**

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | Filter by status: `sandbox`, `production`, `disabled` |
| `limit` | `integer` | Results per page (1-100). Default: 20 |
| `starting_after` | `string` | Cursor for pagination. Pass the `id` of the last endpoint. |

**Response: 200 OK**

```json
{
  "data": [
    { "id": "ep_8xKj2mNpQr", "status": "production", "merchant_name": "Acme Weather API", "amount": "500" },
    { "id": "ep_3yLp7qRsUv", "status": "sandbox", "merchant_name": "Acme Forecast API", "amount": "1500" }
  ],
  "has_more": false
}
```

---

### Update an endpoint

```
PATCH /v1/endpoints/{endpoint_id}
```

```bash
curl -X PATCH https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr \
  -H "Authorization: Bearer mpp_test_sk_abc123" \
  -H "Content-Type: application/json" \
  -d '{"amount": "1000", "description": "Premium weather data"}'
```

**Updatable fields:** `amount`, `currency`, `description`, `merchant_name`, `upstream_url`, `upstream_headers`, `billing_required`, `status`

**Response: 200 OK** — Returns the updated endpoint object.

---

### Delete an endpoint

```
DELETE /v1/endpoints/{endpoint_id}
```

```bash
curl -X DELETE https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr \
  -H "Authorization: Bearer mpp_test_sk_abc123"
```

**Response: 204 No Content**

Keys are rotated and the endpoint URL returns 404 within 60 seconds.

---

## Keys

### Rotate keys

```
POST /v1/endpoints/{endpoint_id}/keys/rotate
```

```bash
curl -X POST https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr/keys/rotate \
  -H "Authorization: Bearer mpp_test_sk_abc123"
```

**Response: 200 OK**

```json
{
  "kid": "key_v2_ep_8xKj2mNpQr",
  "previous_kid": "key_v1_ep_8xKj2mNpQr",
  "previous_expires_at": "2026-03-20T01:05:00Z"
}
```

The old key remains valid for 5 minutes to allow in-flight transactions to complete.

### Get public key (JWKS)

```
GET /.well-known/jwks/{endpoint_id}
```

```bash
curl https://mpp.acquirer.com/.well-known/jwks/ep_8xKj2mNpQr
```

```json
{
  "keys": [
    {
      "kty": "RSA",
      "n": "0vx7agoebGcQSuu...",
      "e": "AQAB",
      "alg": "RSA-OAEP-256",
      "use": "enc",
      "kid": "key_v2_ep_8xKj2mNpQr"
    }
  ]
}
```

This is a public endpoint. No authentication required. Agents and client enablers use this to encrypt tokens.

---

## Transactions

### List transactions

```
GET /v1/endpoints/{endpoint_id}/transactions
```

```bash
curl "https://api.mpp-endpoint.com/v1/endpoints/ep_8xKj2mNpQr/transactions?limit=5" \
  -H "Authorization: Bearer mpp_test_sk_abc123"
```

**Query parameters**

| Field | Type | Description |
|-------|------|-------------|
| `limit` | `integer` | Results per page (1-100). Default: 20 |
| `starting_after` | `string` | Cursor for pagination |
| `status` | `string` | Filter: `success`, `declined`, `error`, `voided` |

**Response: 200 OK**

```json
{
  "data": [
    {
      "id": "txn_7kMn8oPq",
      "endpoint_id": "ep_8xKj2mNpQr",
      "challenge_id": "ch_9fLm3nOpQs",
      "amount": "500",
      "currency": "usd",
      "status": "success",
      "network": "visa",
      "pan_last_four": "4242",
      "gateway_reference": "WP-20260320-001",
      "created_at": "2026-03-20T01:00:05Z",
      "latency_ms": 230
    }
  ],
  "has_more": true
}
```

---

## Authentication

API keys are scoped to an environment:

| Key prefix | Environment | Real charges? |
|------------|-------------|---------------|
| `mpp_test_sk_*` | Sandbox | No |
| `mpp_live_sk_*` | Production | Yes |

You can use sandbox keys to create and manage endpoints, but those endpoints will only process test payments. Switch to a production key and set `status: "production"` to go live.

**Error: 401 Unauthorized**

```json
{
  "error": {
    "type": "authentication_error",
    "message": "Invalid API key. Check that your key starts with mpp_test_sk_ or mpp_live_sk_."
  }
}
```
