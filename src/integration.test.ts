import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createEndpoint, getEndpoint, deleteEndpoint } from './store.js'
import { handleMppRequest } from './mpp-handler.js'
import { encryptJWE } from './crypto.js'

describe('Endpoint management', () => {
  it('creates an endpoint with defaults', () => {
    const ep = createEndpoint({
      upstream_url: 'https://api.example.com/weather',
      amount: '500',
      currency: 'usd',
      merchant_name: 'Test Weather API',
    })

    assert.ok(ep.id.startsWith('ep_'))
    assert.equal(ep.status, 'sandbox')
    assert.equal(ep.amount, '500')
    assert.equal(ep.currency, 'usd')
    assert.equal(ep.merchantName, 'Test Weather API')
    assert.deepEqual(ep.acceptedNetworks, ['visa'])
    assert.ok(ep.keys.kid.includes(ep.id))
  })

  it('deletes an endpoint', () => {
    const ep = createEndpoint({
      upstream_url: 'https://api.example.com/delete-me',
      amount: '100',
      currency: 'usd',
      merchant_name: 'Delete Me',
    })
    assert.ok(getEndpoint(ep.id))
    assert.ok(deleteEndpoint(ep.id))
    assert.equal(getEndpoint(ep.id), undefined)
  })
})

describe('MPP protocol flow', () => {
  let endpointId: string

  before(() => {
    const ep = createEndpoint({
      upstream_url: 'https://httpbin.org/get',
      amount: '500',
      currency: 'usd',
      merchant_name: 'Test API',
    })
    endpointId = ep.id
  })

  it('returns 402 with challenge for unpaid request', async () => {
    const req = new Request('http://localhost/v1/mpp/test?city=sf', { method: 'GET' })
    const res = await handleMppRequest(endpointId, req)

    assert.equal(res.status, 402)
    const wwwAuth = res.headers.get('WWW-Authenticate')
    assert.ok(wwwAuth, 'Should have WWW-Authenticate header')
    assert.ok(wwwAuth.includes('method="card"'))
    assert.ok(wwwAuth.includes('intent="charge"'))
    assert.ok(wwwAuth.includes('\\"amount\\":\\"500\\"') || wwwAuth.includes('"amount":"500"'), 'Challenge should contain amount 500')
    assert.equal(res.headers.get('Cache-Control'), 'no-store')

    const body = await res.json()
    assert.equal(body.type, 'https://paymentauth.org/problems/payment-required')
    assert.equal(body.status, 402)
    assert.ok(body.detail.includes('$5.00'))
  })

  it('returns 404 for non-existent endpoint', async () => {
    const req = new Request('http://localhost/v1/mpp/fake', { method: 'GET' })
    const res = await handleMppRequest('ep_nonexistent', req)
    assert.equal(res.status, 404)
  })

  it('rejects malformed Authorization header', async () => {
    const req = new Request('http://localhost/v1/mpp/test', {
      method: 'GET',
      headers: { Authorization: 'Payment garbage' },
    })
    const res = await handleMppRequest(endpointId, req)
    assert.equal(res.status, 402)
    const body = await res.json()
    assert.ok(body.type.includes('malformed-credential'))
  })

  it('rejects invalid challenge ID', async () => {
    const req = new Request('http://localhost/v1/mpp/test', {
      method: 'GET',
      headers: {
        Authorization: 'Payment id="ch_fake", method="card", intent="charge", payload="eyJ0ZXN0IjoxfQ"',
      },
    })
    const res = await handleMppRequest(endpointId, req)
    assert.equal(res.status, 402)
    const body = await res.json()
    assert.ok(body.type.includes('invalid-challenge'))
  })

  it('completes full 402 -> pay -> receipt flow', async () => {
    // Step 1: Get challenge
    const req1 = new Request('http://localhost/v1/mpp/test?city=sf', { method: 'GET' })
    const res1 = await handleMppRequest(endpointId, req1)
    assert.equal(res1.status, 402)

    const wwwAuth = res1.headers.get('WWW-Authenticate')!
    const challengeIdMatch = wwwAuth.match(/id="(ch_[^"]+)"/)
    assert.ok(challengeIdMatch, 'Challenge ID should be in WWW-Authenticate')
    const challengeId = challengeIdMatch![1]

    // Step 2: Encrypt a test token with the endpoint's public key
    const endpoint = getEndpoint(endpointId)!
    const tokenData = JSON.stringify({
      pan: 'card_test_success',
      cryptogram: 'test_cryptogram_abc123',
      expirationMonth: '12',
      expirationYear: '2028',
    })
    const encryptedPayload = encryptJWE(tokenData, endpoint.keys.publicKey, endpoint.keys.kid)

    // Step 3: Retry with credential
    const credential = {
      encryptedPayload,
      network: 'visa',
      panLastFour: '4242',
      panExpirationMonth: '12',
      panExpirationYear: '2028',
    }
    const payloadB64 = Buffer.from(JSON.stringify(credential)).toString('base64url')

    const req2 = new Request('http://localhost/v1/mpp/test?city=sf', {
      method: 'GET',
      headers: {
        Authorization: `Payment id="${challengeId}", method="card", intent="charge", payload=${payloadB64}`,
      },
    })

    const res2 = await handleMppRequest(endpointId, req2)

    // Should either be 200 (if upstream is reachable) or 502 (if httpbin is down)
    // In test, httpbin may not be reachable, so we check for either outcome
    if (res2.status === 200) {
      assert.ok(res2.headers.get('Payment-Receipt'), 'Should have Payment-Receipt header')
      assert.equal(res2.headers.get('Cache-Control'), 'private')
    } else {
      // 502 means payment succeeded but upstream failed (which is correct behavior)
      assert.ok([502, 504].includes(res2.status), `Expected 200, 502, or 504 but got ${res2.status}`)
    }
  })

  it('rejects reuse of a challenge ID', async () => {
    // Get a challenge
    const req1 = new Request('http://localhost/v1/mpp/test', { method: 'GET' })
    const res1 = await handleMppRequest(endpointId, req1)
    const wwwAuth = res1.headers.get('WWW-Authenticate')!
    const challengeId = wwwAuth.match(/id="(ch_[^"]+)"/)![1]

    // Use it once
    const endpoint = getEndpoint(endpointId)!
    const encryptedPayload = encryptJWE(
      JSON.stringify({ pan: 'card_test_success', cryptogram: 'test' }),
      endpoint.keys.publicKey,
      endpoint.keys.kid,
    )
    const payloadB64 = Buffer.from(
      JSON.stringify({ encryptedPayload, network: 'visa', panLastFour: '4242', panExpirationMonth: '12', panExpirationYear: '2028' }),
    ).toString('base64url')

    const req2 = new Request('http://localhost/v1/mpp/test', {
      method: 'GET',
      headers: { Authorization: `Payment id="${challengeId}", method="card", intent="charge", payload=${payloadB64}` },
    })
    await handleMppRequest(endpointId, req2)

    // Try to reuse the same challenge
    const req3 = new Request('http://localhost/v1/mpp/test', {
      method: 'GET',
      headers: { Authorization: `Payment id="${challengeId}", method="card", intent="charge", payload=${payloadB64}` },
    })
    const res3 = await handleMppRequest(endpointId, req3)
    assert.equal(res3.status, 402)
    const body = await res3.json()
    assert.ok(body.type.includes('invalid-challenge'))
  })

  it('handles sandbox decline scenarios', async () => {
    // Get a challenge
    const req1 = new Request('http://localhost/v1/mpp/test', { method: 'GET' })
    const res1 = await handleMppRequest(endpointId, req1)
    const challengeId = res1.headers.get('WWW-Authenticate')!.match(/id="(ch_[^"]+)"/)![1]

    // Encrypt a decline test card
    const endpoint = getEndpoint(endpointId)!
    const encryptedPayload = encryptJWE(
      JSON.stringify({ pan: 'card_test_decline_funds', cryptogram: 'test' }),
      endpoint.keys.publicKey,
      endpoint.keys.kid,
    )
    const payloadB64 = Buffer.from(
      JSON.stringify({ encryptedPayload, network: 'visa', panLastFour: '0002', panExpirationMonth: '12', panExpirationYear: '2028' }),
    ).toString('base64url')

    const req2 = new Request('http://localhost/v1/mpp/test', {
      method: 'GET',
      headers: { Authorization: `Payment id="${challengeId}", method="card", intent="charge", payload=${payloadB64}` },
    })
    const res2 = await handleMppRequest(endpointId, req2)
    assert.equal(res2.status, 402)
    const body = await res2.json()
    assert.ok(body.detail.includes('Insufficient funds'))
  })
})
