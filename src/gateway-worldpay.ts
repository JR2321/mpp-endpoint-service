/**
 * Worldpay gateway adapter stub.
 *
 * This is a scaffold for integrating with Worldpay's authorization API.
 * Production implementation requires:
 * - Worldpay merchant credentials (entity ID, installation ID)
 * - Worldpay XML or REST API endpoint
 * - PCI-compliant network configuration
 *
 * Worldpay uses XML-based Direct API or newer REST APIs for
 * e-commerce authorization. Network tokens (DPAN + cryptogram) are
 * submitted as part of the payment instrument data.
 */

import type { GatewayAdapter, ChargeParams, ChargeResult } from './types.js'
import crypto from 'node:crypto'

export interface WorldpayConfig {
  /** Worldpay merchant entity ID */
  merchantCode: string
  /** Worldpay installation ID */
  installationId: string
  /** Worldpay XML Direct API endpoint */
  apiEndpoint: string
  /** Worldpay credentials (username) */
  username: string
  /** Worldpay credentials (password) */
  password: string
  /** Test mode: if true, uses Worldpay test environment */
  testMode?: boolean
}

export function createWorldpayGateway(config: WorldpayConfig): GatewayAdapter {
  const { merchantCode, installationId, apiEndpoint, username, password } = config

  return {
    async charge(params: ChargeParams): Promise<ChargeResult> {
      const reference = `wp_${crypto.randomBytes(8).toString('base64url')}`

      // Build Worldpay authorization XML
      // In production, this would construct a proper XML payload:
      //
      // <?xml version="1.0" encoding="UTF-8"?>
      // <!DOCTYPE paymentService PUBLIC "-//WorldPay/DTD WorldPay PaymentService v1//EN"
      //   "http://dtd.worldpay.com/paymentService_v1.dtd">
      // <paymentService version="1.4" merchantCode="{merchantCode}">
      //   <submit>
      //     <order orderCode="{idempotencyKey}" installationId="{installationId}">
      //       <description>MPP Card Payment</description>
      //       <amount currencyCode="{currency}" value="{amount}" exponent="2"/>
      //       <paymentDetails>
      //         <EMVCO_TOKEN-SSL>
      //           <dpan>{token.pan}</dpan>
      //           <cryptogram>{token.cryptogram}</cryptogram>
      //           <expiryDate>
      //             <date month="{token.expirationMonth}" year="{token.expirationYear}"/>
      //           </expiryDate>
      //         </EMVCO_TOKEN-SSL>
      //       </paymentDetails>
      //     </order>
      //   </submit>
      // </paymentService>

      try {
        // TODO: Implement actual Worldpay API call
        // const response = await fetch(apiEndpoint, {
        //   method: 'POST',
        //   headers: {
        //     'Content-Type': 'application/xml',
        //     'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
        //   },
        //   body: xml,
        //   signal: AbortSignal.timeout(5000),
        // })
        //
        // Parse XML response for <lastEvent> to determine AUTHORISED vs REFUSED

        throw new Error(
          'Worldpay gateway is not yet configured. ' +
            'Set WORLDPAY_MERCHANT_CODE, WORLDPAY_INSTALLATION_ID, etc. ' +
            'See docs/gateway-adapters.md for setup instructions.',
        )
      } catch (err) {
        return {
          reference,
          status: 'error',
          declineMessage: err instanceof Error ? err.message : 'Unknown Worldpay error',
        }
      }
    },

    async void(params) {
      // Worldpay uses modification requests (cancel) to void authorizations
      // POST to same endpoint with <cancelOrRefund> XML
      return { reference: params.reference, status: 'voided' }
    },
  }
}
