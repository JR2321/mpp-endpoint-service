# Error Reference

Every error the service returns, what causes it, and how to fix it.

## MPP protocol errors (402 responses)

These are returned to agents hitting your MPP endpoints. They follow the MPP Problem Details format (RFC 9457).

### payment-required

```json
{
  "type": "https://paymentauth.org/problems/payment-required",
  "title": "Payment Required",
  "status": 402,
  "detail": "This resource requires a card payment of $5.00 USD."
}
```

**Cause:** The agent made a request without an `Authorization: Payment` header.

**Fix:** This is the normal first step of the MPP flow. The agent should parse the `WWW-Authenticate` header, provision a payment credential, and retry.

---

### invalid-challenge

```json
{
  "type": "https://paymentauth.org/problems/invalid-challenge",
  "title": "Invalid Challenge",
  "status": 402,
  "detail": "Challenge ID ch_abc123 is unknown, expired, or already used."
}
```

**Cause:** One of:
- The challenge ID in the credential doesn't match any active challenge
- The challenge expired (challenges are valid for 5 minutes)
- The challenge was already used (challenges are single-use)

**Fix:** Use the fresh challenge in the new 402 response. Don't cache or reuse challenge IDs.

---

### malformed-credential

```json
{
  "type": "https://paymentauth.org/problems/malformed-credential",
  "title": "Malformed Credential",
  "status": 402,
  "detail": "The Authorization header could not be parsed. Expected base64url-encoded JSON payload."
}
```

**Cause:** The `Authorization: Payment` header is present but the payload is not valid base64url, the JSON is malformed, or required fields are missing.

**Fix:** Verify the credential matches the [credential payload schema](./concepts.md#step-4-agent-retries-with-payment-credential). Required fields: `encryptedPayload`, `network`, `panLastFour`, `panExpirationMonth`, `panExpirationYear`.

---

### verification-failed

```json
{
  "type": "https://paymentauth.org/problems/verification-failed",
  "title": "Payment Verification Failed",
  "status": 402,
  "detail": "Card declined: insufficient funds."
}
```

**Cause:** One of:
- JWE decryption failed (token was not encrypted with the correct public key)
- The acquirer's gateway declined the transaction
- The cryptogram validation failed at the card network

**Fix:** Depends on the `detail` message:
- "decryption failed": Ensure the token was encrypted using the `encryptionJwk` from the most recent challenge
- "insufficient funds", "do not honor": Card issue on the agent side
- "invalid cryptogram": The Client Enabler produced a bad cryptogram. Retry with a fresh token.

Check the `Retry-After` header. If present, the decline may be temporary.

---

### method-unsupported

```json
{
  "type": "https://paymentauth.org/problems/method-unsupported",
  "title": "Method Not Supported",
  "status": 402,
  "detail": "This endpoint accepts card payments only. Received method: tempo."
}
```

**Cause:** The agent sent a credential for a payment method this endpoint doesn't accept (e.g., stablecoin credential to a card-only endpoint).

**Fix:** Check the `method` field in the 402 challenge. This service only supports `method="card"`.

---

## Management API errors

These are returned by the endpoint management API (`api.mpp-endpoint.com`).

### 401 Unauthorized

```json
{
  "error": {
    "type": "authentication_error",
    "message": "Invalid API key. Check that your key starts with mpp_test_sk_ or mpp_live_sk_."
  }
}
```

**Fix:** Verify your API key. Sandbox keys start with `mpp_test_sk_`, production keys with `mpp_live_sk_`.

---

### 400 Bad Request

```json
{
  "error": {
    "type": "validation_error",
    "message": "amount must be a positive integer string.",
    "field": "amount"
  }
}
```

Common validation errors:

| Field | Rule | Example of valid value |
|-------|------|----------------------|
| `amount` | Positive integer string | `"500"` |
| `currency` | ISO 4217, lowercase | `"usd"` |
| `upstream_url` | Valid HTTPS URL | `"https://api.acme.com/weather"` |
| `merchant_name` | 1-100 characters | `"Acme Weather API"` |
| `accepted_networks` | Non-empty array of supported networks | `["visa"]` |

---

### 404 Not Found

```json
{
  "error": {
    "type": "not_found",
    "message": "Endpoint ep_8xKj2mNpQr not found."
  }
}
```

**Fix:** Check the endpoint ID. If the endpoint was recently deleted, it takes up to 60 seconds to fully deactivate.

---

### 409 Conflict

```json
{
  "error": {
    "type": "conflict",
    "message": "Cannot set status to production: acquirer gateway not configured."
  }
}
```

**Cause:** Tried to activate a production endpoint before the acquirer's gateway is configured.

**Fix:** Contact your acquirer to complete gateway configuration, or stay in sandbox mode for testing.

---

## Proxy errors

These are returned when the service can't reach or get a valid response from your upstream API.

### 502 Bad Gateway

```json
{
  "error": {
    "type": "upstream_error",
    "message": "Upstream returned HTTP 500.",
    "upstream_status": 500
  }
}
```

**Cause:** Your API returned a 4xx or 5xx response. The payment was not captured (charges only complete on upstream 2xx).

**Fix:** Check your upstream API logs. The service proxied the request exactly as received.

---

### 504 Gateway Timeout

```json
{
  "error": {
    "type": "upstream_timeout",
    "message": "Upstream did not respond within 10 seconds."
  }
}
```

**Cause:** Your API took longer than 10 seconds to respond. The payment was not captured.

**Fix:** Optimize your API response time or increase the timeout in your endpoint configuration.

---

## HTTP status code summary

| Status | When | Payment captured? |
|--------|------|-------------------|
| 200 | Payment succeeded, upstream returned 2xx | Yes |
| 402 | No credential, invalid credential, or payment declined | No |
| 403 | Payment succeeded but access denied by policy | Yes |
| 502 | Upstream returned 4xx/5xx | No |
| 504 | Upstream timed out | No |
