import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mppCardMiddleware, generateKeyPair } from './middleware.js'
import { sandboxGateway } from './gateway-sandbox.js'
import { encryptJWE } from './crypto.js'

describe('Middleware mode', () => {
  const keys = generateKeyPair('mw_test')
  const mw = mppCardMiddleware({
    amount: '100',
    currency: 'usd',
    merchantName: 'Test Middleware',
    gateway: sandboxGateway,
    keys,
    secretKey: 'test-secret',
  })

  it('returns 402 for unpaid request', async () => {
    const req = new Request('http://localhost/api/data', { method: 'GET' })
    const res = await mw(req, async () => new Response('ok'))

    assert.equal(res.status, 402)
    const wwwAuth = res.headers.get('WWW-Authenticate')
    assert.ok(wwwAuth?.includes('method="card"'))
    assert.ok(wwwAuth?.includes('intent="charge"'))
  })

  it('passes through to handler after payment', async () => {
    // Step 1: Get challenge
    const req1 = new Request('http://localhost/api/data', { method: 'GET' })
    const res1 = await mw(req1, async () => new Response('ok'))
    assert.equal(res1.status, 402)

    const wwwAuth = res1.headers.get('WWW-Authenticate')!
    const challengeId = wwwAuth.match(/id="(ch_[^"]+)"/)![1]

    // Step 2: Encrypt token and pay
    const tokenData = JSON.stringify({ pan: 'card_test_success', cryptogram: 'test' })
    const encryptedPayload = encryptJWE(tokenData, keys.publicKey, keys.kid)
    const credential = {
      encryptedPayload,
      network: 'visa',
      panLastFour: '4242',
      panExpirationMonth: '12',
      panExpirationYear: '2028',
    }
    const payloadB64 = Buffer.from(JSON.stringify(credential)).toString('base64url')

    const req2 = new Request('http://localhost/api/data', {
      method: 'GET',
      headers: {
        Authorization: `Payment id="${challengeId}", method="card", intent="charge", payload=${payloadB64}`,
      },
    })

    const handlerCalled = { value: false }
    const res2 = await mw(req2, async () => {
      handlerCalled.value = true
      return new Response(JSON.stringify({ result: 'premium data' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })

    assert.ok(handlerCalled.value, 'Route handler should be called after payment')
    assert.equal(res2.status, 200)
    assert.ok(res2.headers.get('Payment-Receipt'))

    const body = await res2.json()
    assert.equal(body.result, 'premium data')
  })

  it('supports dynamic pricing via function', async () => {
    const dynamicMw = mppCardMiddleware({
      amount: (req) => {
        const url = new URL(req.url)
        return url.searchParams.get('tier') === 'pro' ? '1000' : '100'
      },
      currency: 'usd',
      merchantName: 'Dynamic Pricing Test',
      gateway: sandboxGateway,
      keys,
      secretKey: 'test-secret-2',
    })

    const req = new Request('http://localhost/api/data?tier=pro', { method: 'GET' })
    const res = await dynamicMw(req, async () => new Response('ok'))

    assert.equal(res.status, 402)
    const body = await res.json()
    assert.ok(body.detail.includes('$10.00'))
  })

  it('rejects replay of used challenge', async () => {
    // Get challenge
    const req1 = new Request('http://localhost/api/data', { method: 'GET' })
    const res1 = await mw(req1, async () => new Response('ok'))
    const challengeId = res1.headers.get('WWW-Authenticate')!.match(/id="(ch_[^"]+)"/)![1]

    // Use it
    const encryptedPayload = encryptJWE(
      JSON.stringify({ pan: 'card_test_success', cryptogram: 'test' }),
      keys.publicKey,
      keys.kid,
    )
    const payloadB64 = Buffer.from(
      JSON.stringify({ encryptedPayload, network: 'visa', panLastFour: '4242', panExpirationMonth: '12', panExpirationYear: '2028' }),
    ).toString('base64url')

    const authHeader = `Payment id="${challengeId}", method="card", intent="charge", payload=${payloadB64}`

    await mw(
      new Request('http://localhost/api/data', { method: 'GET', headers: { Authorization: authHeader } }),
      async () => new Response('ok'),
    )

    // Replay
    const res3 = await mw(
      new Request('http://localhost/api/data', { method: 'GET', headers: { Authorization: authHeader } }),
      async () => new Response('ok'),
    )
    assert.equal(res3.status, 402)
    const body = await res3.json()
    assert.ok(body.type.includes('invalid-challenge'))
  })
})
