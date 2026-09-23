import { describe, expect, it } from 'vitest'
import { webhookConfigBodySchema, webhookRegenerateSecretBodySchema } from '../src/schemas/webhooks.js'

// Neither schema declares a `secret` field at all — Zod's default object
// parsing strips unrecognized keys rather than rejecting them, so this
// confirms a client that tries to smuggle its own `secret` into PUT
// /config or POST /regenerate-secret has it silently dropped before the
// route ever sees it, not merely "never referenced by the app".
describe('webhookConfigBodySchema', () => {
  it('ignores a client-supplied secret field', () => {
    const parsed = webhookConfigBodySchema.parse({
      organizationId: '11111111-1111-4111-8111-111111111111',
      url: 'https://example.com/hook',
      isActive: true,
      secret: 'attacker-supplied-fake-secret',
    })
    expect(parsed).not.toHaveProperty('secret')
    expect(parsed).toEqual({
      organizationId: '11111111-1111-4111-8111-111111111111',
      url: 'https://example.com/hook',
      isActive: true,
    })
  })
})

describe('webhookRegenerateSecretBodySchema', () => {
  it('ignores a client-supplied secret field', () => {
    const parsed = webhookRegenerateSecretBodySchema.parse({
      organizationId: '11111111-1111-4111-8111-111111111111',
      secret: 'attacker-supplied-fake-secret',
    })
    expect(parsed).not.toHaveProperty('secret')
    expect(parsed).toEqual({ organizationId: '11111111-1111-4111-8111-111111111111' })
  })

  it('rejects a missing/invalid organizationId', () => {
    expect(() => webhookRegenerateSecretBodySchema.parse({})).toThrow()
    expect(() => webhookRegenerateSecretBodySchema.parse({ organizationId: 'not-a-uuid' })).toThrow()
  })
})
