import { describe, expect, it } from 'vitest'
import { toPublicConfig } from '../src/repositories/webhook-repository.js'
import type { WebhookConfigurationRow } from '../src/repositories/webhook-repository.js'

// toPublicConfig() is the one function every response in routes/webhooks.ts
// uses to build the `config` field — GET /config, the update branch of PUT
// /config, and the `config` half of the create/regenerate responses all go
// through it. This is the single place a `secret` leak into a normal
// config read could happen, so it gets tested directly.
describe('toPublicConfig', () => {
  const row: WebhookConfigurationRow = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    organization_id: 'org-1234-0000-0000-0000-000000000000',
    url: 'https://example.com/hook',
    is_active: true,
    // Obviously-fake placeholder — never a real secret, only proves the
    // stripping behavior regardless of what value is present.
    secret: 'fake-secret-for-test-only-not-real',
    created_by: 'user-1234-0000-0000-0000-000000000000',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }

  it('never includes secret in its output', () => {
    const result = toPublicConfig(row)
    expect(result).not.toHaveProperty('secret')
    expect(JSON.stringify(result)).not.toContain('fake-secret-for-test-only-not-real')
  })

  it('maps every other field to its camelCase equivalent', () => {
    const result = toPublicConfig(row)
    expect(result).toEqual({
      id: row.id,
      organizationId: row.organization_id,
      url: row.url,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  })
})
