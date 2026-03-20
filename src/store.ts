/**
 * In-memory store for endpoints, challenges, and transactions.
 *
 * Production deployments should replace this with a persistent store
 * (Postgres, Redis, etc.). This in-memory implementation is sufficient
 * for development, testing, and single-instance deployments.
 */

import crypto from 'node:crypto'
import { generateKeyPair } from './crypto.js'
import type {
  EndpointConfig,
  EndpointWithKeys,
  StoredChallenge,
  Transaction,
  CreateEndpointRequest,
  UpdateEndpointRequest,
} from './types.js'

// ── Endpoints ───────────────────────────────────────────────────────

const endpoints = new Map<string, EndpointWithKeys>()

function genId(): string {
  return `ep_${crypto.randomBytes(8).toString('base64url')}`
}

export function createEndpoint(req: CreateEndpointRequest): EndpointConfig & { keys: { jwks_uri: string; kid: string } } {
  const id = genId()
  const now = new Date().toISOString()
  const keys = generateKeyPair(id)

  const endpoint: EndpointWithKeys = {
    id,
    status: 'sandbox',
    upstreamUrl: req.upstream_url,
    upstreamMethod: req.upstream_method,
    amount: req.amount,
    currency: req.currency,
    merchantName: req.merchant_name,
    description: req.description,
    acceptedNetworks: req.accepted_networks || ['visa'],
    billingRequired: req.billing_required || false,
    upstreamHeaders: req.upstream_headers,
    createdAt: now,
    updatedAt: now,
    keys,
  }

  endpoints.set(id, endpoint)

  return {
    ...toPublic(endpoint),
    keys: {
      jwks_uri: `/.well-known/jwks/${id}`,
      kid: keys.kid,
    },
  }
}

export function getEndpoint(id: string): EndpointWithKeys | undefined {
  return endpoints.get(id)
}

export function listEndpoints(opts?: { status?: string; limit?: number; after?: string }): {
  data: (EndpointConfig & { keys: { jwks_uri: string; kid: string } })[]
  has_more: boolean
} {
  const limit = opts?.limit || 20
  let all = Array.from(endpoints.values())
  if (opts?.status) all = all.filter((e) => e.status === opts.status)
  if (opts?.after) {
    const idx = all.findIndex((e) => e.id === opts.after)
    if (idx >= 0) all = all.slice(idx + 1)
  }
  const page = all.slice(0, limit)
  return {
    data: page.map((e) => ({
      ...toPublic(e),
      keys: { jwks_uri: `/.well-known/jwks/${e.id}`, kid: e.keys.kid },
    })),
    has_more: all.length > limit,
  }
}

export function updateEndpoint(id: string, req: UpdateEndpointRequest): EndpointConfig | null {
  const ep = endpoints.get(id)
  if (!ep) return null

  if (req.amount !== undefined) ep.amount = req.amount
  if (req.currency !== undefined) ep.currency = req.currency
  if (req.merchant_name !== undefined) ep.merchantName = req.merchant_name
  if (req.description !== undefined) ep.description = req.description
  if (req.upstream_url !== undefined) ep.upstreamUrl = req.upstream_url
  if (req.upstream_headers !== undefined) ep.upstreamHeaders = req.upstream_headers
  if (req.billing_required !== undefined) ep.billingRequired = req.billing_required
  if (req.status !== undefined) ep.status = req.status
  ep.updatedAt = new Date().toISOString()

  return toPublic(ep)
}

export function deleteEndpoint(id: string): boolean {
  return endpoints.delete(id)
}

export function rotateKeys(id: string): { kid: string; previous_kid: string; previous_expires_at: string } | null {
  const ep = endpoints.get(id)
  if (!ep) return null

  const version = parseInt(ep.keys.kid.match(/v(\d+)/)?.[1] || '1') + 1
  const previousKid = ep.keys.kid
  ep.previousKeys = ep.keys
  ep.previousKeysExpireAt = Date.now() + 5 * 60 * 1000 // 5 min
  ep.keys = generateKeyPair(id, version)
  ep.updatedAt = new Date().toISOString()

  return {
    kid: ep.keys.kid,
    previous_kid: previousKid,
    previous_expires_at: new Date(ep.previousKeysExpireAt).toISOString(),
  }
}

function toPublic(ep: EndpointWithKeys): EndpointConfig {
  const { keys, previousKeys, previousKeysExpireAt, ...config } = ep
  return config
}

// ── Challenges ──────────────────────────────────────────────────────

const challenges = new Map<string, StoredChallenge>()

const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export function storeChallenge(challenge: StoredChallenge): void {
  challenges.set(challenge.id, challenge)
}

export function getChallenge(id: string): StoredChallenge | null {
  const ch = challenges.get(id)
  if (!ch) return null
  if (Date.now() - ch.createdAt > CHALLENGE_TTL_MS) {
    challenges.delete(id)
    return null
  }
  return ch
}

export function markChallengeUsed(id: string): void {
  const ch = challenges.get(id)
  if (ch) ch.used = true
}

// Cleanup expired challenges periodically
setInterval(() => {
  const now = Date.now()
  for (const [id, ch] of challenges) {
    if (now - ch.createdAt > CHALLENGE_TTL_MS * 2) {
      challenges.delete(id)
    }
  }
}, 60_000)

// ── Transactions ────────────────────────────────────────────────────

const transactions: Transaction[] = []

export function recordTransaction(txn: Transaction): void {
  transactions.push(txn)
}

export function listTransactions(
  endpointId: string,
  opts?: { limit?: number; status?: string; after?: string },
): { data: Transaction[]; has_more: boolean } {
  const limit = opts?.limit || 20
  let filtered = transactions.filter((t) => t.endpointId === endpointId)
  if (opts?.status) filtered = filtered.filter((t) => t.status === opts.status)
  // Most recent first
  filtered = filtered.reverse()
  if (opts?.after) {
    const idx = filtered.findIndex((t) => t.id === opts.after)
    if (idx >= 0) filtered = filtered.slice(idx + 1)
  }
  const page = filtered.slice(0, limit)
  return { data: page, has_more: filtered.length > limit }
}
