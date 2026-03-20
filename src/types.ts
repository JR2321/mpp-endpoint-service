/**
 * Core types for the MPP Endpoint-as-a-Service.
 */

import type { JWK, KeyPair } from './crypto.js'

// ── Endpoint configuration ──────────────────────────────────────────

export interface EndpointConfig {
  id: string
  status: 'sandbox' | 'production' | 'disabled'
  upstreamUrl: string
  upstreamMethod?: string
  amount: string
  currency: string
  merchantName: string
  description?: string
  acceptedNetworks: string[]
  billingRequired: boolean
  upstreamHeaders?: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface EndpointWithKeys extends EndpointConfig {
  keys: KeyPair
  previousKeys?: KeyPair
  previousKeysExpireAt?: number
}

// ── MPP protocol types ──────────────────────────────────────────────

export interface ChallengeRequest {
  amount: string
  currency: string
  description?: string
  recipient?: string
  externalId?: string
  methodDetails: {
    acceptedNetworks: string[]
    merchantName: string
    encryptionJwk?: JWK
    jwksUri?: string
    kid?: string
    billingRequired?: boolean
  }
}

export interface StoredChallenge {
  id: string
  hmac: string
  endpointId: string
  request: ChallengeRequest
  digest?: string // SHA-256 body digest for POST/PUT/PATCH
  createdAt: number
  used: boolean
}

export interface CredentialPayload {
  encryptedPayload: string
  network: string
  panLastFour: string
  panExpirationMonth: string
  panExpirationYear: string
  billingAddress?: {
    street: string
    city: string
    state: string
    postalCode: string
    country: string
  }
  cardholderFullName?: string
  paymentAccountReference?: string
}

export interface DecryptedToken {
  pan: string
  cryptogram: string
  expirationMonth: string
  expirationYear: string
  billingAddress?: CredentialPayload['billingAddress']
}

// ── Gateway adapter types ───────────────────────────────────────────

export interface ChargeParams {
  token: DecryptedToken
  amount: string
  currency: string
  idempotencyKey: string
  merchantId?: string
  terminalId?: string
}

export interface ChargeResult {
  reference: string
  status: 'success' | 'declined' | 'error'
  declineCode?: string
  declineMessage?: string
}

export interface GatewayAdapter {
  charge(params: ChargeParams): Promise<ChargeResult>
  void?(params: { reference: string; merchantId?: string }): Promise<{ status: 'voided' | 'error'; reference: string }>
}

// ── Management API types ────────────────────────────────────────────

export interface CreateEndpointRequest {
  upstream_url: string
  upstream_method?: string
  amount: string
  currency: string
  merchant_name: string
  description?: string
  accepted_networks?: string[]
  billing_required?: boolean
  upstream_headers?: Record<string, string>
}

export interface UpdateEndpointRequest {
  amount?: string
  currency?: string
  merchant_name?: string
  description?: string
  upstream_url?: string
  upstream_headers?: Record<string, string>
  billing_required?: boolean
  status?: 'sandbox' | 'production' | 'disabled'
}

// ── Discovery types ─────────────────────────────────────────────────

export interface DiscoveryService {
  id: string
  name: string
  description?: string
  payment_method: string
  accepted_networks: string[]
  charge: { amount: string; currency: string }
  routes: { method: string; path: string; environment: string }[]
}

export interface DiscoveryResponse {
  merchant: string
  services: DiscoveryService[]
}

// ── Transaction types ───────────────────────────────────────────────

export interface Transaction {
  id: string
  endpointId: string
  challengeId: string
  amount: string
  currency: string
  status: 'success' | 'declined' | 'error' | 'voided'
  network: string
  panLastFour: string
  gatewayReference: string
  declineCode?: string
  declineMessage?: string
  createdAt: string
  latencyMs: number
}
