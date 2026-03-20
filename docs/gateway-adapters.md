# Gateway Adapters

For acquirers integrating their processing infrastructure with MPP Endpoint-as-a-Service.

## Overview

A gateway adapter translates decrypted MPP card tokens into authorization requests for a specific acquirer. Each acquirer has its own API format, authentication method, and response schema. The adapter normalizes these differences behind a single interface.

## The adapter interface

Every adapter implements one function:

```typescript
interface GatewayAdapter {
  charge(params: {
    token: {
      pan: string              // Network token PAN (not the real card number)
      cryptogram: string       // Transaction-specific cryptogram
      expirationMonth: string  // "01" through "12"
      expirationYear: string   // "2028"
      billingAddress?: {
        street: string
        city: string
        state: string
        postalCode: string
        country: string        // ISO 3166-1 alpha-2
      }
    }
    amount: string             // Smallest currency unit (e.g., "500" = $5.00)
    currency: string           // ISO 4217 (e.g., "usd")
    idempotencyKey: string     // Unique per challenge, safe for retries
    merchantId: string         // Acquirer-assigned merchant ID
    terminalId?: string        // Terminal ID if applicable
  }): Promise<{
    reference: string          // Transaction ID from the acquirer
    status: 'success' | 'declined' | 'error'
    declineCode?: string       // Network decline code (e.g., "05", "51")
    declineMessage?: string    // Human-readable decline reason
  }>
}
```

That's it. One function, clear inputs, clear outputs.

## Example: Worldpay adapter

```typescript
import type { GatewayAdapter } from '@mpp-endpoint/gateway'

export const worldpay: GatewayAdapter = {
  async charge({ token, amount, currency, idempotencyKey, merchantId }) {
    const response = await fetch('https://api.worldpay.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WORLDPAY_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        transactionType: 'sale',
        merchant: { merchantId },
        paymentMethod: {
          type: 'networkToken',
          networkToken: {
            tokenNumber: token.pan,
            cryptogram: token.cryptogram,
            expiryMonth: token.expirationMonth,
            expiryYear: token.expirationYear,
            tokenSource: 'VISA',
          },
        },
        amount: {
          value: parseInt(amount),
          currency: currency.toUpperCase(),
        },
        ...(token.billingAddress && {
          billingAddress: {
            line1: token.billingAddress.street,
            city: token.billingAddress.city,
            state: token.billingAddress.state,
            postalCode: token.billingAddress.postalCode,
            country: token.billingAddress.country,
          },
        }),
      }),
    })

    const data = await response.json()

    if (data.outcome === 'approved') {
      return {
        reference: data.transactionId,
        status: 'success',
      }
    }

    return {
      reference: data.transactionId || 'unknown',
      status: 'declined',
      declineCode: data.responseCode,
      declineMessage: data.responseMessage,
    }
  },
}
```

## Example: Fiserv adapter

```typescript
import type { GatewayAdapter } from '@mpp-endpoint/gateway'

export const fiserv: GatewayAdapter = {
  async charge({ token, amount, currency, idempotencyKey, merchantId }) {
    const response = await fetch('https://prod.api.firstdata.com/gateway/v2/payments', {
      method: 'POST',
      headers: {
        'Api-Key': process.env.FISERV_API_KEY!,
        'Client-Request-Id': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requestType: 'PaymentCardSaleTransaction',
        transactionAmount: {
          total: (parseInt(amount) / 100).toFixed(2),
          currency: currency.toUpperCase(),
        },
        paymentMethod: {
          paymentCard: {
            number: token.pan,
            securityCode: token.cryptogram,
            expiryDate: {
              month: token.expirationMonth,
              year: token.expirationYear,
            },
            type: 'network_token',
          },
        },
        merchantId,
      }),
    })

    const data = await response.json()

    if (data.transactionStatus === 'APPROVED') {
      return {
        reference: data.ipgTransactionId,
        status: 'success',
      }
    }

    return {
      reference: data.ipgTransactionId || 'unknown',
      status: 'declined',
      declineCode: data.processor?.responseCode,
      declineMessage: data.processor?.responseMessage,
    }
  },
}
```

## Registering an adapter (platform mode)

Acquirers register their adapter when onboarding to the platform:

```bash
curl -X POST https://api.mpp-endpoint.com/v1/gateways \
  -H "Authorization: Bearer mpp_platform_sk_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "worldpay",
    "display_name": "Worldpay",
    "authorization_url": "https://api.worldpay.com/v1/payments",
    "auth_type": "bearer",
    "auth_credential_env": "WORLDPAY_API_KEY",
    "supported_networks": ["visa"],
    "supported_currencies": ["usd", "eur", "gbp"],
    "timeout_ms": 5000
  }'
```

```json
{
  "id": "gw_worldpay",
  "name": "worldpay",
  "display_name": "Worldpay",
  "status": "active",
  "supported_networks": ["visa"],
  "supported_currencies": ["usd", "eur", "gbp"],
  "created_at": "2026-03-20T01:00:00Z"
}
```

Merchants on this acquirer automatically route through this gateway when they create endpoints.

## Building a new adapter

1. Implement the `GatewayAdapter` interface (one `charge` function)
2. Map the decrypted network token fields to your gateway's API format
3. Handle authorization responses: map your gateway's success/decline/error states to the three standard statuses
4. Return decline codes and messages so the service can pass them to agents in problem detail responses
5. Test with sandbox credentials

### Common pitfalls

**Network token vs. raw PAN:** The `token.pan` field is a network token, not the cardholder's real card number. Make sure your gateway API call specifies this is a network token transaction, not a standard card-present or card-not-present transaction. Most gateways have a specific field or flag for this.

**Cryptogram format:** The cryptogram is base64-encoded. Some gateways expect hex encoding. Check your gateway's documentation.

**Amount formatting:** The `amount` field is in the smallest currency unit (e.g., cents). Some gateways expect decimal amounts (e.g., "5.00" instead of "500"). Convert as needed.

**Idempotency:** Always pass the `idempotencyKey` to your gateway. This prevents double-charging if the service retries after a network timeout.

## Void/reversal support

If the merchant's upstream API fails after a successful authorization, the service needs to void the transaction. Adapters should implement an optional `void` method:

```typescript
interface GatewayAdapter {
  charge(params: ChargeParams): Promise<ChargeResult>
  
  void?(params: {
    reference: string       // Transaction reference from the charge result
    merchantId: string
  }): Promise<{
    status: 'voided' | 'error'
    reference: string
  }>
}
```

If `void` is not implemented, the service logs the orphaned authorization for manual reconciliation.

## Testing your adapter

Use the adapter test harness to verify your implementation:

```bash
npx @mpp-endpoint/gateway test --adapter ./worldpay.ts
```

The harness runs these scenarios:

| Scenario | Expected result |
|----------|----------------|
| Valid token, sufficient funds | `status: 'success'` with a reference |
| Valid token, insufficient funds | `status: 'declined'` with decline code |
| Invalid token (bad cryptogram) | `status: 'declined'` or `status: 'error'` |
| Gateway timeout (>5s) | Promise rejects or `status: 'error'` |
| Duplicate idempotency key | Same result as the first call |
| Void after successful charge | `status: 'voided'` |
