/**
 * MPP Endpoint-as-a-Service
 *
 * Main server entrypoint. Provides:
 * 1. Management API (create/list/update/delete endpoints)
 * 2. MPP proxy (402 challenge/credential flow + upstream proxying)
 * 3. JWKS endpoint (public keys for token encryption)
 * 4. Discovery endpoint (service catalog)
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import {
  createEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  deleteEndpoint,
  rotateKeys,
  listTransactions,
} from './store.js'
import { handleMppRequest } from './mpp-handler.js'
import type {
  CreateEndpointRequest,
  UpdateEndpointRequest,
  DiscoveryResponse,
} from './types.js'

const app = new Hono()

// ── Health check ────────────────────────────────────────────────────

app.get('/health', (c) => c.json({ status: 'ok', service: 'mpp-endpoint-service', version: '0.1.0' }))

// ── Management API ──────────────────────────────────────────────────
// In production, these would be behind API key authentication.
// For v1, we keep it open for development and testing.

app.post('/v1/endpoints', async (c) => {
  const body = await c.req.json<CreateEndpointRequest>()

  // Validate required fields
  if (!body.upstream_url) return c.json({ error: { type: 'validation_error', message: 'upstream_url is required.', field: 'upstream_url' } }, 400)
  if (!body.amount) return c.json({ error: { type: 'validation_error', message: 'amount is required.', field: 'amount' } }, 400)
  if (!body.currency) return c.json({ error: { type: 'validation_error', message: 'currency is required.', field: 'currency' } }, 400)
  if (!body.merchant_name) return c.json({ error: { type: 'validation_error', message: 'merchant_name is required.', field: 'merchant_name' } }, 400)

  // Validate amount is a positive integer string
  if (!/^\d+$/.test(body.amount) || parseInt(body.amount) <= 0) {
    return c.json({ error: { type: 'validation_error', message: 'amount must be a positive integer string.', field: 'amount' } }, 400)
  }

  // Validate upstream URL
  try {
    new URL(body.upstream_url)
  } catch {
    return c.json({ error: { type: 'validation_error', message: 'upstream_url must be a valid URL.', field: 'upstream_url' } }, 400)
  }

  const endpoint = createEndpoint(body)
  return c.json(endpoint, 201)
})

app.get('/v1/endpoints', (c) => {
  const status = c.req.query('status')
  const limit = parseInt(c.req.query('limit') || '20')
  const after = c.req.query('starting_after')
  const result = listEndpoints({ status, limit, after })
  return c.json(result)
})

app.get('/v1/endpoints/:id', (c) => {
  const ep = getEndpoint(c.req.param('id'))
  if (!ep) return c.json({ error: { type: 'not_found', message: 'Endpoint not found.' } }, 404)

  const { keys, previousKeys, previousKeysExpireAt, ...config } = ep
  return c.json({
    ...config,
    keys: { jwks_uri: `/.well-known/jwks/${ep.id}`, kid: ep.keys.kid },
  })
})

app.patch('/v1/endpoints/:id', async (c) => {
  const body = await c.req.json<UpdateEndpointRequest>()

  if (body.amount !== undefined && (!/^\d+$/.test(body.amount) || parseInt(body.amount) <= 0)) {
    return c.json({ error: { type: 'validation_error', message: 'amount must be a positive integer string.', field: 'amount' } }, 400)
  }

  const result = updateEndpoint(c.req.param('id'), body)
  if (!result) return c.json({ error: { type: 'not_found', message: 'Endpoint not found.' } }, 404)
  return c.json(result)
})

app.delete('/v1/endpoints/:id', (c) => {
  const deleted = deleteEndpoint(c.req.param('id'))
  if (!deleted) return c.json({ error: { type: 'not_found', message: 'Endpoint not found.' } }, 404)
  return new Response(null, { status: 204 })
})

// ── Key management ──────────────────────────────────────────────────

app.post('/v1/endpoints/:id/keys/rotate', (c) => {
  const result = rotateKeys(c.req.param('id'))
  if (!result) return c.json({ error: { type: 'not_found', message: 'Endpoint not found.' } }, 404)
  return c.json(result)
})

// JWKS endpoint (public, no auth required)
app.get('/.well-known/jwks/:id', (c) => {
  const ep = getEndpoint(c.req.param('id'))
  if (!ep) return c.json({ error: 'Not found' }, 404)

  const keys = [ep.keys.jwk]
  // Include previous key if still valid
  if (ep.previousKeys && ep.previousKeysExpireAt && Date.now() < ep.previousKeysExpireAt) {
    keys.push(ep.previousKeys.jwk)
  }

  return c.json({ keys })
})

// ── Transactions ────────────────────────────────────────────────────

app.get('/v1/endpoints/:id/transactions', (c) => {
  const ep = getEndpoint(c.req.param('id'))
  if (!ep) return c.json({ error: { type: 'not_found', message: 'Endpoint not found.' } }, 404)

  const limit = parseInt(c.req.query('limit') || '20')
  const status = c.req.query('status')
  const after = c.req.query('starting_after')

  return c.json(listTransactions(c.req.param('id'), { limit, status, after }))
})

// ── Discovery ───────────────────────────────────────────────────────

app.get('/v1/discover', (c) => {
  const allEndpoints = listEndpoints({ limit: 1000 })

  const response: DiscoveryResponse = {
    merchant: 'MPP Endpoint Service',
    services: allEndpoints.data.map((ep) => ({
      id: ep.id,
      name: ep.merchantName,
      description: ep.description,
      payment_method: 'card',
      accepted_networks: ep.acceptedNetworks,
      charge: { amount: ep.amount, currency: ep.currency },
      routes: [
        {
          method: 'GET',
          path: `/v1/mpp/${ep.id}`,
          environment: ep.status,
        },
      ],
    })),
  }

  return c.json(response)
})

// ── MPP Proxy Endpoints ─────────────────────────────────────────────
// Catch-all route: /v1/mpp/:endpointId handles the MPP 402 flow

app.all('/v1/mpp/:id', (c) => {
  return handleMppRequest(c.req.param('id'), c.req.raw)
})

app.all('/v1/mpp/:id/*', (c) => {
  return handleMppRequest(c.req.param('id'), c.req.raw)
})

// ── Start server ────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '3000')

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║           MPP Endpoint-as-a-Service v0.1.0              ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Management API:                                         ║
║    POST   /v1/endpoints          Create endpoint         ║
║    GET    /v1/endpoints          List endpoints           ║
║    GET    /v1/endpoints/:id      Get endpoint             ║
║    PATCH  /v1/endpoints/:id      Update endpoint          ║
║    DELETE /v1/endpoints/:id      Delete endpoint          ║
║                                                          ║
║  MPP Proxy:                                              ║
║    ANY    /v1/mpp/:id            Payment-gated proxy      ║
║                                                          ║
║  Discovery:                                              ║
║    GET    /v1/discover           Service catalog           ║
║                                                          ║
║  Keys:                                                   ║
║    GET    /.well-known/jwks/:id  Public encryption key     ║
║    POST   /v1/endpoints/:id/keys/rotate  Rotate keys      ║
║                                                          ║
║  Server running on http://localhost:${info.port}              ║
╚══════════════════════════════════════════════════════════╝
`)
})

export default app
