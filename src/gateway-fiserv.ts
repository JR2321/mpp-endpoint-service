/**
 * Fiserv (First Data) gateway adapter stub.
 *
 * This is a scaffold for integrating with Fiserv's Commerce Hub
 * (formerly First Data / Clover Connect) authorization API.
 *
 * Production implementation requires:
 * - Fiserv Commerce Hub API key and secret
 * - Merchant ID
 * - PCI-compliant network configuration
 *
 * Fiserv Commerce Hub uses REST with HMAC-SHA256 request signing.
 * Network tokens are submitted via the paymentCard.networkToken fields.
 */

import type { GatewayAdapter, ChargeParams, ChargeResult } from './types.js'
import crypto from 'node:crypto'

export interface FiservConfig {
  /** Fiserv Commerce Hub API key */
  apiKey: string
  /** Fiserv Commerce Hub API secret (for HMAC signing) */
  apiSecret: string
  /** Merchant ID */
  merchantId: string
  /** Terminal ID (optional) */
  terminalId?: string
  /** API endpoint (defaults to Fiserv Commerce Hub) */
  apiEndpoint?: string
  /** Test mode */
  testMode?: boolean
}

export function createFiservGateway(config: FiservConfig): GatewayAdapter {
  const {
    apiKey,
    apiSecret,
    merchantId,
    apiEndpoint = 'https://cert.api.fiservapps.com/ch/payments/v1/charges',
  } = config

  return {
    async charge(params: ChargeParams): Promise<ChargeResult> {
      const reference = `fv_${crypto.randomBytes(8).toString('base64url')}`

      // Build Fiserv Commerce Hub authorization request
      // In production, this constructs a signed JSON payload:
      //
      // POST /ch/payments/v1/charges
      // Headers:
      //   Api-Key: {apiKey}
      //   Client-Request-Id: {idempotencyKey}
      //   Timestamp: {unixMs}
      //   Auth-Token-Type: HMAC
      //   Authorization: {hmac_sha256(apiKey + clientRequestId + timestamp + payload, apiSecret)}
      //
      // Body:
      // {
      //   "amount": { "total": 5.00, "currency": "USD" },
      //   "source": {
      //     "sourceType": "PaymentToken",
      //     "tokenSource": "NETWORK_TOKEN",
      //     "tokenData": "{token.pan}",
      //     "expirationMonth": "{token.expirationMonth}",
      //     "expirationYear": "{token.expirationYear}",
      //     "cryptogram": "{token.cryptogram}",
      //     "cryptogramType": "VISA"
      //   },
      //   "transactionDetails": {
      //     "merchantTransactionId": "{idempotencyKey}"
      //   },
      //   "merchantDetails": {
      //     "merchantId": "{merchantId}"
      //   }
      // }

      try {
        // TODO: Implement actual Fiserv API call with HMAC signing
        // const timestamp = Date.now().toString()
        // const payload = JSON.stringify(requestBody)
        // const message = apiKey + params.idempotencyKey + timestamp + payload
        // const hmac = crypto.createHmac('sha256', apiSecret).update(message).digest('base64')
        //
        // const response = await fetch(apiEndpoint, {
        //   method: 'POST',
        //   headers: {
        //     'Content-Type': 'application/json',
        //     'Api-Key': apiKey,
        //     'Client-Request-Id': params.idempotencyKey,
        //     'Timestamp': timestamp,
        //     'Auth-Token-Type': 'HMAC',
        //     'Authorization': hmac,
        //   },
        //   body: payload,
        //   signal: AbortSignal.timeout(5000),
        // })
        //
        // Parse response for approvalStatus: 'APPROVED' vs 'DECLINED'

        throw new Error(
          'Fiserv gateway is not yet configured. ' +
            'Set FISERV_API_KEY, FISERV_API_SECRET, FISERV_MERCHANT_ID. ' +
            'See docs/gateway-adapters.md for setup instructions.',
        )
      } catch (err) {
        return {
          reference,
          status: 'error',
          declineMessage: err instanceof Error ? err.message : 'Unknown Fiserv error',
        }
      }
    },

    async void(params) {
      // Fiserv uses POST /ch/payments/v1/cancels with the original transaction reference
      return { reference: params.reference, status: 'voided' }
    },
  }
}
