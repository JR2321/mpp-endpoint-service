import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateKeyPair,
  encryptJWE,
  decryptJWE,
  generateChallengeId,
  signChallenge,
  verifyChallenge,
  computeBodyDigest,
} from './crypto.js'

describe('Key generation', () => {
  it('generates RSA-2048 key pair with correct JWK fields', () => {
    const kp = generateKeyPair('ep_test123')
    assert.equal(kp.jwk.kty, 'RSA')
    assert.equal(kp.jwk.alg, 'RSA-OAEP-256')
    assert.equal(kp.jwk.use, 'enc')
    assert.equal(kp.jwk.kid, 'key_v1_ep_test123')
    assert.ok(kp.jwk.n.length > 100, 'RSA modulus should be large')
    assert.equal(kp.jwk.e, 'AQAB')
  })

  it('generates unique key IDs with version', () => {
    const kp1 = generateKeyPair('ep_test', 1)
    const kp2 = generateKeyPair('ep_test', 2)
    assert.equal(kp1.kid, 'key_v1_ep_test')
    assert.equal(kp2.kid, 'key_v2_ep_test')
  })
})

describe('JWE encrypt/decrypt', () => {
  it('round-trips plaintext through JWE', () => {
    const kp = generateKeyPair('ep_jwe_test')
    const payload = JSON.stringify({ pan: '4111111111111111', cryptogram: 'abc123' })

    const jwe = encryptJWE(payload, kp.publicKey, kp.kid)
    assert.ok(jwe.split('.').length === 5, 'JWE should have 5 parts')

    const decrypted = decryptJWE(jwe, kp.privateKey)
    assert.equal(decrypted, payload)
  })

  it('fails to decrypt with wrong key', () => {
    const kp1 = generateKeyPair('ep_key1')
    const kp2 = generateKeyPair('ep_key2')
    const jwe = encryptJWE('secret', kp1.publicKey, kp1.kid)

    assert.throws(() => decryptJWE(jwe, kp2.privateKey))
  })

  it('fails on malformed JWE', () => {
    const kp = generateKeyPair('ep_bad')
    assert.throws(() => decryptJWE('not.a.valid.jwe.string', kp.privateKey))
  })
})

describe('Challenge IDs', () => {
  it('generates unique challenge IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateChallengeId()))
    assert.equal(ids.size, 100, 'All challenge IDs should be unique')
  })

  it('starts with ch_ prefix', () => {
    const id = generateChallengeId()
    assert.ok(id.startsWith('ch_'))
  })
})

describe('HMAC signing', () => {
  it('verifies valid HMAC', () => {
    const key = 'test-secret-key'
    const id = 'ch_test123'
    const hmac = signChallenge(id, key)
    assert.ok(verifyChallenge(id, hmac, key))
  })

  it('rejects invalid HMAC', () => {
    const key = 'test-secret-key'
    const hmac = signChallenge('ch_test123', key)
    assert.ok(!verifyChallenge('ch_different', hmac, key))
  })
})

describe('Body digest', () => {
  it('computes SHA-256 digest in RFC 9530 format', () => {
    const digest = computeBodyDigest('{"hello":"world"}')
    assert.ok(digest.startsWith('sha-256=:'))
    assert.ok(digest.endsWith(':'))
  })

  it('produces consistent digests', () => {
    const body = '{"test":"data"}'
    assert.equal(computeBodyDigest(body), computeBodyDigest(body))
  })

  it('produces different digests for different bodies', () => {
    assert.notEqual(computeBodyDigest('body1'), computeBodyDigest('body2'))
  })
})
