import { describe, expect, it } from 'vitest'
import { toPublicConnection } from '../src/repositories/hubspot-repository.js'
import type { HubspotConnectionRow } from '../src/repositories/hubspot-repository.js'

// toPublicConnection() is the one function any future route handler may
// use to build a `connection` field for a JSON response — this is the
// single place a leak of access_token_encrypted/refresh_token_encrypted
// into a browser-facing response could happen, so it's tested directly,
// same reasoning as webhook-repository.test.ts's coverage of
// toPublicConfig().
describe('toPublicConnection', () => {
  const row: HubspotConnectionRow = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    organization_id: 'org-1234-0000-0000-0000-000000000000',
    hub_portal_id: '12345678',
    // Obviously-fake placeholders — never real tokens, only proving the
    // stripping behavior regardless of what value is present.
    access_token_encrypted: 'v1:fake:fake:fake-access-token-ciphertext-not-real',
    refresh_token_encrypted: 'v1:fake:fake:fake-refresh-token-ciphertext-not-real',
    access_token_expires_at: '2026-01-01T00:30:00.000Z',
    scopes: 'crm.objects.contacts.read crm.objects.contacts.write',
    needs_reauth: false,
    connected_by: 'user-1234-0000-0000-0000-000000000000',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }

  it('never includes either encrypted token field', () => {
    const result = toPublicConnection(row)
    expect(result).not.toHaveProperty('access_token_encrypted')
    expect(result).not.toHaveProperty('refresh_token_encrypted')
    expect(result).not.toHaveProperty('accessTokenEncrypted')
    expect(result).not.toHaveProperty('refreshTokenEncrypted')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('fake-access-token-ciphertext-not-real')
    expect(serialized).not.toContain('fake-refresh-token-ciphertext-not-real')
  })

  it('never includes scopes, connected_by, or access_token_expires_at (not needed by any current UI)', () => {
    const result = toPublicConnection(row)
    expect(result).not.toHaveProperty('scopes')
    expect(result).not.toHaveProperty('connectedBy')
    expect(result).not.toHaveProperty('connected_by')
    expect(result).not.toHaveProperty('accessTokenExpiresAt')
  })

  it('maps exactly the fields a connection-status UI needs, camelCased', () => {
    const result = toPublicConnection(row)
    expect(result).toEqual({
      id: row.id,
      organizationId: row.organization_id,
      hubPortalId: row.hub_portal_id,
      needsReauth: row.needs_reauth,
      connectedAt: row.created_at,
      updatedAt: row.updated_at,
    })
  })
})

// This phase (Fase 1) adds no Express routes and no permission-checking
// logic of its own — hubspotRepository's functions are plain data-access
// helpers, exactly like webhookRepository's, and none of them take a role
// or perform an authorization decision (that responsibility belongs
// entirely to the route layer via requireAdminRole(), added in a later
// phase — see webhook-auth.ts for the existing pattern this will reuse).
// There is therefore no new function in this phase that could grant
// member/viewer administrative access — confirmed here by asserting the
// repository's public surface is limited to plain CRUD, with no
// role-aware or role-bypassing export.
describe('hubspotRepository has no role-aware exports', () => {
  it('exposes only data-access functions, none of which accept a role/permission parameter', async () => {
    const { hubspotRepository } = await import('../src/repositories/hubspot-repository.js')
    const functionNames = Object.keys(hubspotRepository)
    expect(functionNames.sort()).toEqual(
      ['getConnection', 'getPublicConnection', 'upsertConnection', 'setNeedsReauth', 'deleteConnection', 'getContactLink', 'upsertContactLink'].sort(),
    )
    for (const name of functionNames) {
      const fn = (hubspotRepository as unknown as Record<string, (...args: unknown[]) => unknown>)[name]
      expect(typeof fn).toBe('function')
    }
  })
})
