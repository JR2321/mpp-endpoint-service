/**
 * MPP Endpoint Middleware (R6)
 *
 * Drop-in middleware for Hono, Express, Next.js, and any Fetch API-compatible server.
 * Merchants embed this in their own server to add MPP card payment gating
 * without the hosted proxy.
 *
 * Usage (Hono):
 *   import { mppCardMiddleware } from '@mpp-endpoint/middleware'
 *   app.use('/paid-api/*', mppCardMiddleware({ ... }))
 *
 * Usage (Express via toNodeMiddleware):
 *   import { mppCardMiddleware, toNodeMiddleware } from '@mpp-endpoint/middleware'
 *   app.use('/paid-api', toNodeMiddleware(mppCardMiddleware({ ... })))
 */

import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  generateKeyPair,
  generateChallengeId,
  signChallenge,
  decryptJWE,
  computeBodyDigest,
  type KeyPair,
} from './crypto.js'
import type { GatewayAdapter, ChargeResult, ChallengeRequest, CredentialPayload } from './types.js'

export interface MppMiddlewareConfig {
  /** Charge amount in minor units (e.g. "500" for $5.00) */
  amount: string | ((req: Request) => string | Promise<string>)
  /** ISO 4217 currency code */
  currency: string
  /** Merchant display name shown in 402 challenges */
  merchantName: string
  /** Description shown in 402 challenges */
  description?: string
  /** Accepted card networks (default: ['visa']) */
  acceptedNetworks?: string[]
  /** Whether billing address is required */
  billingRequired?: boolean
  /** Gateway adapter for card authorization */
  gateway: GatewayAdapter
  /** RSA key pair (auto-generated if omitted) */
  keys?: KeyPair
  /** Secret key for HMAC challenge binding (auto-generated if omitted) */
  secretKey?: string
  /** Challenge TTL in ms (default: 300000 = 5 min) */
  challengeTtlMs?: number
  /** Upstream timeout in ms (default: 10000) */
  upstreamTimeoutMs?: number
  /**
   * Dynamic pricing callback. If `amount` is a function, it's called with the request.
   * Alternatively, set this to a URL and the middleware will POST the request details
   * to get the amount back.
   */
  pricingWebhookUrl?: string
}

interface StoredChallenge {
  id: string
  hmac: string
  request: ChallengeRequest
  digest?: string
  createdAt: number
  used: boolean
}

/**
 * Creates an MPP card payment middleware compatible with any Fetch API server.
 *
 * Returns a function (request: Request, next: () => Promise<Response>) => Promise<Response>
 */
export function mppCardMiddleware(config: MppMiddlewareConfig) {
  const {
    currency,
    merchantName,
    description,
    acceptedNetworks = ['visa'],
    billingRequired = false,
    gateway,
    secretKey = crypto.randomBytes(32).toString('base64'),
    challengeTtlMs = 5 * 60 * 1000,
  } = config

  // Auto-generate keys if not provided
  const keys = config.keys || generateKeyPair(`mw_${crypto.randomBytes(4).toString('hex')}`)

  // In-memory challenge store (per-instance)
  const challenges = new Map<string, StoredChallenge>()

  // Periodic cleanup
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [id, ch] of challenges) {
      if (now - ch.createdAt > challengeTtlMs * 2) {
        challenges.delete(id)
      }
    }
  }, 60_000)

  // Allow cleanup to be stopped (for testing, graceful shutdown)
  if (typeof cleanup === 'object' && 'unref' in cleanup) {
    cleanup.unref()
  }

  async function resolveAmount(req: Request): Promise<string> {
    if (typeof config.amount === 'function') {
      return config.amount(req)
    }
    if (config.pricingWebhookUrl) {
      const url = new URL(req.url)
      const res = await fetch(config.pricingWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        }),
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) throw new Error(`Pricing webhook returned ${res.status}`)
      const data = (await res.json()) as { amount: string }
      return data.amount
    }
    return config.amount as string
  }

  function buildChallenge(amount: string, body?: string): Response {
    const challengeId = generateChallengeId()
    const hmac = signChallenge(challengeId, secretKey)

    const request: ChallengeRequest = {
      amount,
      currency,
      description: description || merchantName,
      methodDetails: {
        acceptedNetworks,
        merchantName,
        encryptionJwk: keys.jwk,
        billingRequired: billingRequired || undefined,
      },
    }

    const digest = body ? computeBodyDigest(body) : undefined

    challenges.set(challengeId, {
      id: challengeId,
      hmac,
      request,
      digest,
      createdAt: Date.now(),
      used: false,
    })

    const requestJson = JSON.stringify(request)
    let wwwAuth = `Payment id="${challengeId}", method="card", intent="charge", request="${requestJson.replace(/"/g, '\\"')}"`
    if (digest) wwwAuth += `, digest="${digest}"`

    return new Response(
      JSON.stringify({
        type: 'https://paymentauth.org/problems/payment-required',
        title: 'Payment Required',
        status: 402,
        detail: `This resource requires a card payment of $${(parseInt(amount) / 100).toFixed(2)} ${currency.toUpperCase()}.`,
      }),
      {
        status: 402,
        headers: {
          'WWW-Authenticate': wwwAuth,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  function errorResponse(type: string, title: string, detail: string, retryAfter?: number): Response {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }
    if (retryAfter) headers['Retry-After'] = String(retryAfter)

    return new Response(
      JSON.stringify({
        type: `https://paymentauth.org/problems/${type}`,
        title,
        status: 402,
        detail,
      }),
      { status: 402, headers },
    )
  }

  function parsePaymentAuth(header: string): Record<string, string> | null {
    if (!header.startsWith('Payment ')) return null
    const params: Record<string, string> = {}
    const raw = header.slice(8)
    const regex = /(\w+)="([^"]*)"/g
    let match
    while ((match = regex.exec(raw)) !== null) params[match[1]] = match[2]
    const unquotedRegex = /(\w+)=([^",\s]+)/g
    while ((match = unquotedRegex.exec(raw)) !== null) {
      if (!params[match[1]]) params[match[1]] = match[2]
    }
    return params
  }

  /**
   * Middleware handler. Call with the incoming request and a `next` function
   * that invokes the actual route handler.
   */
  return async function handler(
    request: Request,
    next: () => Response | Promise<Response>,
  ): Promise<Response> {
    let requestBody: string | undefined
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      requestBody = await request.text()
    }

    const authHeader = request.headers.get('authorization')

    // No payment: issue challenge
    if (!authHeader || !authHeader.startsWith('Payment ')) {
      const amount = await resolveAmount(request)
      return buildChallenge(amount, requestBody)
    }

    // Parse credential
    const params = parsePaymentAuth(authHeader)
    if (!params || !params.id || !params.payload) {
      return errorResponse('malformed-credential', 'Malformed Credential', 'The Authorization header could not be parsed.')
    }

    // Validate challenge
    const challenge = challenges.get(params.id)
    if (!challenge || challenge.used || Date.now() - challenge.createdAt > challengeTtlMs) {
      return errorResponse('invalid-challenge', 'Invalid Challenge', `Challenge ID ${params.id} is unknown, expired, or already used.`)
    }

    // Verify body digest
    if (challenge.digest && requestBody) {
      if (computeBodyDigest(requestBody) !== challenge.digest) {
        return errorResponse('invalid-challenge', 'Invalid Challenge', 'Request body does not match the challenge digest.')
      }
    }

    // Parse credential payload
    let credential: CredentialPayload
    try {
      credential = JSON.parse(
        params.payload.startsWith('{') ? params.payload : Buffer.from(params.payload, 'base64url').toString(),
      )
    } catch {
      return errorResponse('malformed-credential', 'Malformed Credential', 'Could not parse credential payload.')
    }

    if (!credential.encryptedPayload || !credential.network || !credential.panLastFour) {
      return errorResponse('malformed-credential', 'Malformed Credential', 'Missing required credential fields.')
    }

    // Decrypt token
    let tokenData: { pan: string; cryptogram: string; expirationMonth?: string; expirationYear?: string }
    try {
      const decrypted = decryptJWE(credential.encryptedPayload, keys.privateKey)
      tokenData = JSON.parse(decrypted)
    } catch {
      challenge.used = true
      return errorResponse('verification-failed', 'Payment Verification Failed', 'Token decryption failed.')
    }

    // Mark used before gateway call
    challenge.used = true

    // Authorize
    let chargeResult: ChargeResult
    try {
      chargeResult = await gateway.charge({
        token: {
          pan: tokenData.pan,
          cryptogram: tokenData.cryptogram,
          expirationMonth: credential.panExpirationMonth,
          expirationYear: credential.panExpirationYear,
          billingAddress: credential.billingAddress,
        },
        amount: challenge.request.amount,
        currency,
        idempotencyKey: challenge.id,
      })
    } catch {
      return errorResponse('verification-failed', 'Payment Verification Failed', 'Gateway error during authorization.', 30)
    }

    if (chargeResult.status !== 'success') {
      const detail =
        chargeResult.status === 'declined'
          ? `Card declined: ${chargeResult.declineMessage || 'unknown reason'}.`
          : `Payment error: ${chargeResult.declineMessage || 'unknown error'}.`
      return errorResponse('verification-failed', 'Payment Verification Failed', detail, 30)
    }

    // Payment succeeded. Call the actual route handler.
    const response = await next()

    // Attach receipt
    const receipt = `id="${challenge.id}", method="card", intent="charge", receipt="${JSON.stringify({ reference: chargeResult.reference, status: 'success' }).replace(/"/g, '\\"')}"`

    const headers = new Headers(response.headers)
    headers.set('Payment-Receipt', receipt)
    headers.set('Cache-Control', 'private')

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/**
 * JWKS endpoint handler. Returns the public key for the middleware instance.
 */
export function jwksHandler(keys: KeyPair) {
  return () =>
    new Response(JSON.stringify({ keys: [keys.jwk] }), {
      headers: { 'Content-Type': 'application/json' },
    })
}

/**
 * Adapter to use the Fetch-based middleware in Node.js/Express.
 *
 * Usage:
 *   const mw = mppCardMiddleware({ ... })
 *   app.use('/api', toNodeMiddleware(mw))
 */
export function toNodeMiddleware(
  handler: (request: Request, next: () => Promise<Response>) => Promise<Response>,
) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    // Convert IncomingMessage to Fetch Request
    const protocol = (req.headers['x-forwarded-proto'] as string) || 'http'
    const host = req.headers.host || 'localhost'
    const url = `${protocol}://${host}${req.url}`

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }

    let body: string | undefined
    if (['POST', 'PUT', 'PATCH'].includes(req.method || '')) {
      body = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks).toString()))
      })
    }

    const fetchReq = new Request(url, {
      method: req.method,
      headers,
      body: body || undefined,
    })

    const fetchRes = await handler(fetchReq, async () => {
      // If the middleware passes through (payment succeeded), call Express next()
      // We need to capture the Express response. For simplicity, signal with a sentinel.
      return new Response('__NEXT__', { status: 200 })
    })

    // Check if we should pass to next middleware
    const text = await fetchRes.clone().text()
    if (text === '__NEXT__') {
      next()
      return
    }

    // Write the MPP response (402, error, etc.)
    res.writeHead(fetchRes.status, Object.fromEntries(fetchRes.headers.entries()))
    res.end(await fetchRes.text())
  }
}

export { generateKeyPair } from './crypto.js'
export { sandboxGateway } from './gateway-sandbox.js'
export type { GatewayAdapter, ChargeParams, ChargeResult } from './types.js'
