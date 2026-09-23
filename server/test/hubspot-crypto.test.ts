import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptHubspotToken, encryptHubspotToken, parseHubspotEncryptionKey } from '../src/lib/hubspot-crypto.js'

// Obviously-fake placeholder — never a real HubSpot token, only used to
// exercise the encrypt/decrypt round trip deterministically.
const FAKE_TOKEN = 'fake-hubspot-access-token-not-real-0000000000'
const KEY = randomBytes(32)

describe('encryptHubspotToken / decryptHubspotToken', () => {
  it('round-trips: decrypting an encrypted token returns the original plaintext', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    expect(decryptHubspotToken(stored, KEY)).toBe(FAKE_TOKEN)
  })

  it('encrypting the same token twice produces different ciphertext (random IV per call)', () => {
    const first = encryptHubspotToken(FAKE_TOKEN, KEY)
    const second = encryptHubspotToken(FAKE_TOKEN, KEY)
    expect(first).not.toBe(second)
    // Both still decrypt to the same plaintext despite differing.
    expect(decryptHubspotToken(first, KEY)).toBe(FAKE_TOKEN)
    expect(decryptHubspotToken(second, KEY)).toBe(FAKE_TOKEN)
  })

  it('stores a versioned, colon-delimited format', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    const parts = stored.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
  })

  it('fails on a tampered ciphertext segment', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    const [version, iv, authTag, ciphertext] = stored.split(':')
    // Flip the ciphertext to different-but-still-valid-base64 bytes of the
    // same length, so this exercises GCM's authentication check itself,
    // not just a length/format rejection.
    const tamperedBytes = Buffer.from(ciphertext, 'base64')
    tamperedBytes[0] = tamperedBytes[0] ^ 0xff
    const tampered = [version, iv, authTag, tamperedBytes.toString('base64')].join(':')
    expect(() => decryptHubspotToken(tampered, KEY)).toThrow(/authentication failed/)
  })

  it('fails on a tampered authentication tag', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    const [version, iv, authTag, ciphertext] = stored.split(':')
    const tamperedTagBytes = Buffer.from(authTag, 'base64')
    tamperedTagBytes[0] = tamperedTagBytes[0] ^ 0xff
    const tampered = [version, iv, tamperedTagBytes.toString('base64'), ciphertext].join(':')
    expect(() => decryptHubspotToken(tampered, KEY)).toThrow(/authentication failed/)
  })

  it('fails on an unrecognized format (wrong segment count)', () => {
    expect(() => decryptHubspotToken('not:enough:segments', KEY)).toThrow(/unrecognized ciphertext format/)
  })

  it('fails on an unrecognized format version', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    const [, iv, authTag, ciphertext] = stored.split(':')
    const wrongVersion = ['v2', iv, authTag, ciphertext].join(':')
    expect(() => decryptHubspotToken(wrongVersion, KEY)).toThrow(/unrecognized ciphertext format/)
  })

  it('fails on an invalid IV length', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    const [version, , authTag, ciphertext] = stored.split(':')
    const shortIv = Buffer.from([1, 2, 3]).toString('base64')
    const tampered = [version, shortIv, authTag, ciphertext].join(':')
    expect(() => decryptHubspotToken(tampered, KEY)).toThrow(/invalid IV length/)
  })

  it('fails on an invalid authentication tag length', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    const [version, iv, , ciphertext] = stored.split(':')
    const shortTag = Buffer.from([1, 2, 3]).toString('base64')
    const tampered = [version, iv, shortTag, ciphertext].join(':')
    expect(() => decryptHubspotToken(tampered, KEY)).toThrow(/invalid authentication tag length/)
  })

  it('rejects an encryption key of the wrong length', () => {
    const shortKey = randomBytes(16) // AES-128 length, not AES-256
    expect(() => encryptHubspotToken(FAKE_TOKEN, shortKey)).toThrow(/32 bytes/)
  })

  it('rejects a decryption key of the wrong length', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    const shortKey = randomBytes(16)
    expect(() => decryptHubspotToken(stored, shortKey)).toThrow(/32 bytes/)
  })

  it('fails to decrypt with a different (but validly-sized) key', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    const wrongKey = randomBytes(32)
    expect(() => decryptHubspotToken(stored, wrongKey)).toThrow(/authentication failed/)
  })

  it('never leaks plaintext or key material into the stored/error output', () => {
    const stored = encryptHubspotToken(FAKE_TOKEN, KEY)
    expect(stored).not.toContain(FAKE_TOKEN)
    expect(stored).not.toContain(KEY.toString('base64'))
  })
})

describe('parseHubspotEncryptionKey', () => {
  it('accepts a valid 32-byte base64 key', () => {
    const key = randomBytes(32)
    const parsed = parseHubspotEncryptionKey(key.toString('base64'))
    expect(parsed).toBeInstanceOf(Buffer)
    expect(parsed?.equals(key)).toBe(true)
  })

  it('returns undefined for undefined input', () => {
    expect(parseHubspotEncryptionKey(undefined)).toBeUndefined()
  })

  it('returns undefined for an empty/whitespace-only value', () => {
    expect(parseHubspotEncryptionKey('')).toBeUndefined()
    expect(parseHubspotEncryptionKey('   ')).toBeUndefined()
  })

  it('returns undefined for a key of the wrong decoded length', () => {
    expect(parseHubspotEncryptionKey(randomBytes(16).toString('base64'))).toBeUndefined()
    expect(parseHubspotEncryptionKey(randomBytes(48).toString('base64'))).toBeUndefined()
  })
})
