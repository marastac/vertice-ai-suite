import { describe, expect, it } from 'vitest'
import { generateWebhookSecret, signWebhookPayload, verifyWebhookSignature } from '../src/lib/webhook-signature.js'

describe('generateWebhookSecret', () => {
  it('generates a 256-bit (64 hex char) secret', () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates a different secret each call', () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret())
  })
})

describe('signWebhookPayload', () => {
  it('produces a stable sha256= signature for the same secret+body', () => {
    const secret = 'test-secret'
    const body = '{"event":"lead.created"}'
    expect(signWebhookPayload(secret, body)).toBe(signWebhookPayload(secret, body))
    expect(signWebhookPayload(secret, body)).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('produces a different signature for a different body', () => {
    const secret = 'test-secret'
    expect(signWebhookPayload(secret, '{"a":1}')).not.toBe(signWebhookPayload(secret, '{"a":2}'))
  })

  it('produces a different signature for a different secret', () => {
    const body = '{"a":1}'
    expect(signWebhookPayload('secret-a', body)).not.toBe(signWebhookPayload('secret-b', body))
  })
})

describe('verifyWebhookSignature', () => {
  it('accepts a matching signature', () => {
    const secret = 'test-secret'
    const body = '{"event":"lead.created"}'
    expect(verifyWebhookSignature(secret, body, signWebhookPayload(secret, body))).toBe(true)
  })

  it('rejects a tampered body', () => {
    const secret = 'test-secret'
    const signature = signWebhookPayload(secret, '{"event":"lead.created"}')
    expect(verifyWebhookSignature(secret, '{"event":"tampered"}', signature)).toBe(false)
  })

  it('rejects the wrong secret', () => {
    const body = '{"event":"lead.created"}'
    const signature = signWebhookPayload('real-secret', body)
    expect(verifyWebhookSignature('wrong-secret', body, signature)).toBe(false)
  })
})
