/**
 * Sandbox gateway adapter.
 *
 * Simulates card authorization without contacting a real payment processor.
 * Uses test card IDs to trigger different outcomes (success, decline, timeout).
 */

import type { GatewayAdapter, ChargeParams, ChargeResult } from './types.js'
import crypto from 'node:crypto'

const DECLINE_MAP: Record<string, { code: string; message: string }> = {
  card_test_decline_funds: { code: '51', message: 'Insufficient funds' },
  card_test_decline_honor: { code: '05', message: 'Do not honor' },
  card_test_decline_expired: { code: '54', message: 'Expired card' },
}

export const sandboxGateway: GatewayAdapter = {
  async charge(params: ChargeParams): Promise<ChargeResult> {
    const reference = `txn_${crypto.randomBytes(8).toString('base64url')}`

    // Check for test card scenarios based on PAN patterns
    // In sandbox mode, the "PAN" from the decrypted token contains the test card ID
    const pan = params.token.pan

    // Simulate timeout
    if (pan === 'card_test_error_timeout' || pan.includes('timeout')) {
      await new Promise((r) => setTimeout(r, 6000))
      return { reference, status: 'error', declineMessage: 'Gateway timeout' }
    }

    // Simulate network error
    if (pan === 'card_test_error_network' || pan.includes('network_error')) {
      return { reference, status: 'error', declineMessage: 'Network error' }
    }

    // Check for specific decline scenarios
    for (const [testId, decline] of Object.entries(DECLINE_MAP)) {
      if (pan === testId || pan.includes(testId)) {
        return {
          reference,
          status: 'declined',
          declineCode: decline.code,
          declineMessage: decline.message,
        }
      }
    }

    // Default: success
    return { reference, status: 'success' }
  },

  async void(params) {
    return { reference: params.reference, status: 'voided' }
  },
}
