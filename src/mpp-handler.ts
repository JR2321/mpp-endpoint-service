/**
 * MPP protocol handler.
 *
 * Implements the server side of the MPP card charge flow:
 * 1. Unpaid request -> 402 + challenge
 * 2. Paid request -> decrypt token, authorize, proxy upstream, return receipt
 */

import crypto from 'node:crypto'
import {
  generateChallengeId,
  signChallenge,
  verifyChallenge,
  decryptJWE,
  computeBodyDigest,
} from './crypto.js'
import {
  getEndpoint,
  storeChallenge,
  getChallenge,
  markChallengeUsed,
  recordTransaction,
} from './store.js'
import { sandboxGateway } from './gateway-sandbox.js'
import type {
  EndpointWithKeys,
  ChallengeRequest,
  CredentialPayload,
  GatewayAdapter,
  Transaction,
} from './types.js'

const SECRET_KEY = process.env.MPP_SECRET_KEY || crypto.randomBytes(32).toString('base64')

// Registry of gateway adapters per acquirer
const gateways: Record<string, GatewayAdapter> = {
  sandbox: sandboxGateway,
}

export function registerGateway(name: string, adapter: GatewayAdapter): void {
  gateways[name] = adapter
}

/** Parse the Authorization: Payment header. */
function parsePaymentAuth(header: string): Record<string, string> | null {
  if (!header.startsWith('Payment ')) return null
  const params: Record<string, string> = {}
  const raw = header.slice(8) // remove "Payment "

  // Parse key="value" pairs
  const regex = /(\w+)="([^"]*)"/g
  let match
  while ((match = regex.exec(raw)) !== null) {
    params[match[1]] = match[2]
  }

  // Also parse key=value (unquoted) for payload which may be base64url
  const unquotedRegex = /(\w+)=([^",\s]+)/g
  while ((match = unquotedRegex.exec(raw)) !== null) {
    if (!params[match[1]]) {
      params[match[1]] = match[2]
    }
  }

  return params
}

/** Resolve the charge amount, calling pricing webhook if configured. */
async function resolveAmount(endpoint: EndpointWithKeys, request: Request): Promise<string> {
  if (!endpoint.pricingWebhookUrl) return endpoint.amount
  try {
    const url = new URL(request.url)
    const res = await fetch(endpoint.pricingWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint_id: endpoint.id,
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return endpoint.amount // fallback to static price
    const data = (await res.json()) as { amount?: string }
    return data.amount || endpoint.amount
  } catch {
    return endpoint.amount // fallback to static price on error
  }
}

/** Build the 402 challenge response. */
function buildChallengeResponse(endpoint: EndpointWithKeys, body?: string, dynamicAmount?: string): Response {
  const challengeId = generateChallengeId()
  const hmac = signChallenge(challengeId, SECRET_KEY)

  const effectiveAmount = dynamicAmount || endpoint.amount

  const request: ChallengeRequest = {
    amount: effectiveAmount,
    currency: endpoint.currency,
    description: endpoint.description || endpoint.merchantName,
    methodDetails: {
      acceptedNetworks: endpoint.acceptedNetworks,
      merchantName: endpoint.merchantName,
      encryptionJwk: endpoint.keys.jwk,
      billingRequired: endpoint.billingRequired || undefined,
    },
  }

  const digest = body ? computeBodyDigest(body) : undefined

  storeChallenge({
    id: challengeId,
    hmac,
    endpointId: endpoint.id,
    request,
    digest,
    createdAt: Date.now(),
    used: false,
  })

  const requestJson = JSON.stringify(request)
  let wwwAuth = `Payment id="${challengeId}", method="card", intent="charge", request="${requestJson.replace(/"/g, '\\"')}"`
  if (digest) {
    wwwAuth += `, digest="${digest}"`
  }

  const problemBody = {
    type: 'https://paymentauth.org/problems/payment-required',
    title: 'Payment Required',
    status: 402,
    detail: `This resource requires a card payment of $${(parseInt(effectiveAmount) / 100).toFixed(2)} ${endpoint.currency.toUpperCase()}.`,
  }

  return new Response(JSON.stringify(problemBody), {
    status: 402,
    headers: {
      'WWW-Authenticate': wwwAuth,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

/** Build an error 402 response with a specific problem type. */
function buildErrorResponse(
  type: string,
  title: string,
  detail: string,
  endpoint?: EndpointWithKeys,
  retryAfter?: number,
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  }

  // Include a fresh challenge if we have the endpoint
  if (endpoint) {
    const freshChallenge = buildChallengeResponse(endpoint)
    const wwwAuth = freshChallenge.headers.get('WWW-Authenticate')
    if (wwwAuth) headers['WWW-Authenticate'] = wwwAuth
  }

  if (retryAfter) {
    headers['Retry-After'] = String(retryAfter)
  }

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

/** Handle an incoming request to an MPP endpoint. */
export async function handleMppRequest(
  endpointId: string,
  request: Request,
): Promise<Response> {
  const startTime = Date.now()

  const endpoint = getEndpoint(endpointId)
  if (!endpoint) {
    return new Response(JSON.stringify({ error: { type: 'not_found', message: 'Endpoint not found.' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (endpoint.status === 'disabled') {
    return new Response(JSON.stringify({ error: { type: 'not_found', message: 'Endpoint is disabled.' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Check for Authorization: Payment header
  const authHeader = request.headers.get('authorization')

  // Read body once for POST/PUT/PATCH
  let requestBody: string | undefined
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    requestBody = await request.text()
  }

  if (!authHeader || !authHeader.startsWith('Payment ')) {
    // No payment credential: return 402 challenge
    const dynamicAmount = await resolveAmount(endpoint, request)
    return buildChallengeResponse(endpoint, requestBody, dynamicAmount)
  }

  // Parse the payment credential
  const params = parsePaymentAuth(authHeader)
  if (!params || !params.id || !params.payload) {
    return buildErrorResponse('malformed-credential', 'Malformed Credential', 'The Authorization header could not be parsed.', endpoint)
  }

  // Validate challenge
  const challenge = getChallenge(params.id)
  if (!challenge) {
    return buildErrorResponse('invalid-challenge', 'Invalid Challenge', `Challenge ID ${params.id} is unknown, expired, or already used.`, endpoint)
  }

  if (challenge.used) {
    return buildErrorResponse('invalid-challenge', 'Invalid Challenge', `Challenge ID ${params.id} has already been used.`, endpoint)
  }

  if (challenge.endpointId !== endpointId) {
    return buildErrorResponse('invalid-challenge', 'Invalid Challenge', 'Challenge does not belong to this endpoint.', endpoint)
  }

  // Verify body digest for POST/PUT/PATCH
  if (challenge.digest && requestBody) {
    const bodyDigest = computeBodyDigest(requestBody)
    if (bodyDigest !== challenge.digest) {
      return buildErrorResponse('invalid-challenge', 'Invalid Challenge', 'Request body does not match the challenge digest.', endpoint)
    }
  }

  // Parse credential payload
  let credential: CredentialPayload
  try {
    credential = JSON.parse(
      params.payload.startsWith('{') ? params.payload : Buffer.from(params.payload, 'base64url').toString(),
    )
  } catch {
    return buildErrorResponse('malformed-credential', 'Malformed Credential', 'Could not parse credential payload.', endpoint)
  }

  if (!credential.encryptedPayload || !credential.network || !credential.panLastFour) {
    return buildErrorResponse('malformed-credential', 'Malformed Credential', 'Missing required credential fields: encryptedPayload, network, panLastFour.', endpoint)
  }

  // Decrypt the encrypted network token
  let decryptedJson: string
  try {
    // Try current key first, then previous key if available
    try {
      decryptedJson = decryptJWE(credential.encryptedPayload, endpoint.keys.privateKey)
    } catch {
      if (endpoint.previousKeys && endpoint.previousKeysExpireAt && Date.now() < endpoint.previousKeysExpireAt) {
        decryptedJson = decryptJWE(credential.encryptedPayload, endpoint.previousKeys.privateKey)
      } else {
        throw new Error('Decryption failed')
      }
    }
  } catch {
    markChallengeUsed(challenge.id)
    return buildErrorResponse('verification-failed', 'Payment Verification Failed', 'Token decryption failed. Ensure the token was encrypted with the current public key.', endpoint)
  }

  let tokenData: { pan: string; cryptogram: string; expirationMonth?: string; expirationYear?: string }
  try {
    tokenData = JSON.parse(decryptedJson)
  } catch {
    markChallengeUsed(challenge.id)
    return buildErrorResponse('verification-failed', 'Payment Verification Failed', 'Decrypted token is not valid JSON.', endpoint)
  }

  // Mark challenge as used BEFORE gateway call to prevent replays
  markChallengeUsed(challenge.id)

  // Select gateway (per-endpoint override > env var > sandbox)
  const gatewayName =
    endpoint.status === 'production'
      ? (endpoint.gatewayAdapter || process.env.GATEWAY_ADAPTER || 'sandbox')
      : 'sandbox'
  const gateway = gateways[gatewayName] || gateways.sandbox

  // Authorize the payment
  const chargeResult = await gateway.charge({
    token: {
      pan: tokenData.pan,
      cryptogram: tokenData.cryptogram,
      expirationMonth: credential.panExpirationMonth,
      expirationYear: credential.panExpirationYear,
      billingAddress: credential.billingAddress,
    },
    amount: endpoint.amount,
    currency: endpoint.currency,
    idempotencyKey: challenge.id,
  })

  // Record transaction
  const txn: Transaction = {
    id: chargeResult.reference,
    endpointId,
    challengeId: challenge.id,
    amount: endpoint.amount,
    currency: endpoint.currency,
    status: chargeResult.status,
    network: credential.network,
    panLastFour: credential.panLastFour,
    gatewayReference: chargeResult.reference,
    declineCode: chargeResult.declineCode,
    declineMessage: chargeResult.declineMessage,
    createdAt: new Date().toISOString(),
    latencyMs: 0, // will be updated below
  }

  if (chargeResult.status !== 'success') {
    txn.latencyMs = Date.now() - startTime
    recordTransaction(txn)

    const detail =
      chargeResult.status === 'declined'
        ? `Card declined: ${chargeResult.declineMessage || 'unknown reason'}.`
        : `Payment error: ${chargeResult.declineMessage || 'unknown error'}.`

    return buildErrorResponse('verification-failed', 'Payment Verification Failed', detail, endpoint, 30)
  }

  // Payment succeeded. Proxy the request to upstream.
  try {
    const upstreamHeaders = new Headers()
    if (endpoint.upstreamHeaders) {
      for (const [k, v] of Object.entries(endpoint.upstreamHeaders)) {
        upstreamHeaders.set(k, v)
      }
    }

    // Forward original request headers (except auth)
    const skipHeaders = new Set(['authorization', 'host', 'connection'])
    request.headers.forEach((v, k) => {
      if (!skipHeaders.has(k.toLowerCase()) && !upstreamHeaders.has(k)) {
        upstreamHeaders.set(k, v)
      }
    })

    const upstreamUrl = new URL(endpoint.upstreamUrl)
    // Append query params from the original request
    const originalUrl = new URL(request.url)
    originalUrl.searchParams.forEach((v, k) => {
      upstreamUrl.searchParams.set(k, v)
    })

    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: endpoint.upstreamMethod || request.method,
      headers: upstreamHeaders,
      body: requestBody || undefined,
      signal: AbortSignal.timeout(10_000),
    })

    // If upstream fails, void the payment
    if (!upstreamResponse.ok) {
      if (gateway.void) {
        await gateway.void({ reference: chargeResult.reference })
        txn.status = 'voided'
      }
      txn.latencyMs = Date.now() - startTime
      recordTransaction(txn)

      return new Response(
        JSON.stringify({
          error: {
            type: 'upstream_error',
            message: `Upstream returned HTTP ${upstreamResponse.status}.`,
            upstream_status: upstreamResponse.status,
          },
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    txn.latencyMs = Date.now() - startTime
    recordTransaction(txn)

    // Build the receipt header
    const receipt = `id="${challenge.id}", method="card", intent="charge", receipt="${JSON.stringify({ reference: chargeResult.reference, status: 'success' }).replace(/"/g, '\\"')}"`

    // Forward the upstream response with the receipt
    const responseHeaders = new Headers()
    upstreamResponse.headers.forEach((v, k) => {
      if (!['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length'].includes(k.toLowerCase())) {
        responseHeaders.set(k, v)
      }
    })
    responseHeaders.set('Payment-Receipt', receipt)
    responseHeaders.set('Cache-Control', 'private')

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    })
  } catch (err) {
    // Upstream timeout or network error, void the payment
    if (gateway.void) {
      await gateway.void({ reference: chargeResult.reference })
      txn.status = 'voided'
    }
    txn.latencyMs = Date.now() - startTime
    recordTransaction(txn)

    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError'
    if (isTimeout) {
      return new Response(
        JSON.stringify({
          error: { type: 'upstream_timeout', message: 'Upstream did not respond within 10 seconds.' },
        }),
        { status: 504, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({
        error: { type: 'upstream_error', message: 'Failed to reach upstream service.' },
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
