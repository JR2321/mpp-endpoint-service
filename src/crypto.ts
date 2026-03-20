/**
 * RSA key management and JWE encryption/decryption for MPP card tokens.
 *
 * Per the Card Network Charge Intent spec:
 * - Server generates RSA-2048 key pair
 * - Public key (JWK) is included in 402 challenges
 * - Client encrypts network token as JWE (RSA-OAEP-256 + AES-256-GCM)
 * - Server decrypts with private key
 */

import crypto from 'node:crypto'

export interface JWK {
  kty: string
  n: string
  e: string
  alg: string
  use: string
  kid: string
}

export interface KeyPair {
  publicKey: crypto.KeyObject
  privateKey: crypto.KeyObject
  kid: string
  jwk: JWK
}

/** Generate an RSA-2048 key pair for MPP card token encryption. */
export function generateKeyPair(endpointId: string, version = 1): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  const pubKeyObj = crypto.createPublicKey(publicKey)
  const privKeyObj = crypto.createPrivateKey(privateKey)
  const kid = `key_v${version}_${endpointId}`

  const jwkExport = pubKeyObj.export({ format: 'jwk' })

  const jwk: JWK = {
    kty: 'RSA',
    n: jwkExport.n as string,
    e: jwkExport.e as string,
    alg: 'RSA-OAEP-256',
    use: 'enc',
    kid,
  }

  return { publicKey: pubKeyObj, privateKey: privKeyObj, kid, jwk }
}

/** Decrypt a JWE compact serialization using RSA-OAEP-256 + AES-256-GCM. */
export function decryptJWE(jwe: string, privateKey: crypto.KeyObject): string {
  const parts = jwe.split('.')
  if (parts.length !== 5) {
    throw new Error('Invalid JWE: expected 5 parts in compact serialization')
  }

  const [headerB64, encKeyB64, ivB64, ciphertextB64, tagB64] = parts

  // Decode header and verify algorithm
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString())
  if (header.alg !== 'RSA-OAEP-256') {
    throw new Error(`Unsupported JWE algorithm: ${header.alg}`)
  }
  if (header.enc !== 'A256GCM') {
    throw new Error(`Unsupported JWE encryption: ${header.enc}`)
  }

  // Decrypt the content encryption key with RSA-OAEP-256
  const encryptedKey = Buffer.from(encKeyB64, 'base64url')
  const cek = crypto.privateDecrypt(
    {
      key: privateKey,
      oaepHash: 'sha256',
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    encryptedKey,
  )

  // Decrypt content with AES-256-GCM
  const iv = Buffer.from(ivB64, 'base64url')
  const ciphertext = Buffer.from(ciphertextB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const aad = Buffer.from(headerB64, 'ascii')

  const decipher = crypto.createDecipheriv('aes-256-gcm', cek, iv)
  decipher.setAuthTag(tag)
  decipher.setAAD(aad)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf-8')
}

/** Encrypt plaintext as JWE compact serialization (for testing). */
export function encryptJWE(plaintext: string, publicKey: crypto.KeyObject, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid })).toString('base64url')

  // Generate random CEK and IV
  const cek = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)

  // Encrypt CEK with RSA-OAEP-256
  const encryptedKey = crypto.publicEncrypt(
    {
      key: publicKey,
      oaepHash: 'sha256',
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    cek,
  )

  // Encrypt content with AES-256-GCM
  const aad = Buffer.from(header, 'ascii')
  const cipher = crypto.createCipheriv('aes-256-gcm', cek, iv)
  cipher.setAAD(aad)

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    header,
    encryptedKey.toString('base64url'),
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

/** Generate a cryptographically random challenge ID. */
export function generateChallengeId(): string {
  return `ch_${crypto.randomBytes(16).toString('base64url')}`
}

/** Generate an HMAC for challenge integrity. */
export function signChallenge(challengeId: string, secretKey: string): string {
  return crypto.createHmac('sha256', secretKey).update(challengeId).digest('base64url')
}

/** Verify an HMAC for challenge integrity. */
export function verifyChallenge(challengeId: string, hmac: string, secretKey: string): boolean {
  const expected = signChallenge(challengeId, secretKey)
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))
}

/** Compute SHA-256 digest of a request body (RFC 9530 format). */
export function computeBodyDigest(body: string): string {
  const hash = crypto.createHash('sha256').update(body).digest('base64')
  return `sha-256=:${hash}:`
}
