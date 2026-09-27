import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Route-level logic tests for handleOauthCallback()/disconnectHubspotConnection()
// — the two functions routes/hubspot.ts extracts specifically so this is
// testable without an HTTP harness (this project has none). Every real
// dependency (repository, HubSpot OAuth calls, the shared auth helpers,
// encryption) is mocked via vi.doMock() so these tests exercise only the
// route's own decision logic: what gets called, in what order, and what a
// given combination of mock results returns/throws.

const FAKE_ENV = {
  HUBSPOT_CLIENT_ID: 'fake-client-id',
  HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
  HUBSPOT_REDIRECT_URI: 'https://backend.example.test/api/hubspot/oauth/callback',
  FRONTEND_URL: 'https://app.example.test',
  HUBSPOT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}
const ENV_KEYS = Object.keys(FAKE_ENV) as (keyof typeof FAKE_ENV)[]
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  for (const key of ENV_KEYS) process.env[key] = FAKE_ENV[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  vi.resetModules()
  vi.doUnmock('../src/repositories/hubspot-repository.js')
  vi.doUnmock('../src/services/hubspot-oauth.js')
  vi.doUnmock('../src/services/hubspot-contacts.js')
  vi.doUnmock('../src/services/webhook-auth.js')
  vi.doUnmock('../src/lib/hubspot-crypto.js')
})

interface Mocks {
  consumeOauthState?: ReturnType<typeof vi.fn>
  upsertConnection?: ReturnType<typeof vi.fn>
  getConnection?: ReturnType<typeof vi.fn>
  deleteConnection?: ReturnType<typeof vi.fn>
  getContactLink?: ReturnType<typeof vi.fn>
  deleteContactLinksForOrganization?: ReturnType<typeof vi.fn>
  requireOrganizationMembership?: ReturnType<typeof vi.fn>
  requireAdminRole?: ReturnType<typeof vi.fn>
  exchangeCodeForTokens?: ReturnType<typeof vi.fn>
  fetchHubPortalId?: ReturnType<typeof vi.fn>
  revokeRefreshToken?: ReturnType<typeof vi.fn>
  decryptHubspotToken?: ReturnType<typeof vi.fn>
  encryptHubspotToken?: ReturnType<typeof vi.fn>
}

async function loadRoutesWithMocks(mocks: Mocks) {
  vi.resetModules()

  vi.doMock('../src/repositories/hubspot-repository.js', () => ({
    hubspotRepository: {
      consumeOauthState: mocks.consumeOauthState ?? vi.fn(),
      upsertConnection: mocks.upsertConnection ?? vi.fn().mockResolvedValue({}),
      updateTokensAfterRefresh: vi.fn(),
      getConnection: mocks.getConnection ?? vi.fn(),
      deleteConnection: mocks.deleteConnection ?? vi.fn().mockResolvedValue(undefined),
      getPublicConnection: vi.fn(),
      setNeedsReauth: vi.fn(),
      getLeadForSync: vi.fn(),
      getContactLink: mocks.getContactLink ?? vi.fn(),
      deleteContactLinksForOrganization: mocks.deleteContactLinksForOrganization ?? vi.fn().mockResolvedValue(undefined),
      upsertContactLink: vi.fn(),
      createOauthState: vi.fn(),
    },
    // Real implementation, duplicated here rather than imported — same
    // convention already used for parseHubspotEncryptionKey below (a
    // vi.doMock() factory fully replaces the module, so every export
    // routes/hubspot.ts actually uses must be present or it resolves to
    // `undefined` at import time).
    toPublicContactLink: (row: { hubspot_contact_id: string; last_synced_at: string; last_sync_status: string; last_sync_error: string | null }) => ({
      hubspotContactId: row.hubspot_contact_id,
      lastSyncedAt: row.last_synced_at,
      lastSyncStatus: row.last_sync_status,
      lastSyncError: row.last_sync_error,
    }),
  }))

  vi.doMock('../src/services/webhook-auth.js', () => ({
    requireAuthenticatedUser: vi.fn(),
    requireOrganizationMembership: mocks.requireOrganizationMembership ?? vi.fn().mockResolvedValue('owner'),
    requireAdminRole: mocks.requireAdminRole ?? vi.fn(),
    requireEditorRole: vi.fn(),
  }))

  vi.doMock('../src/services/hubspot-oauth.js', () => ({
    buildAuthorizeUrl: vi.fn(),
    exchangeCodeForTokens: mocks.exchangeCodeForTokens ?? vi.fn(),
    fetchHubPortalId: mocks.fetchHubPortalId ?? vi.fn(),
    revokeRefreshToken: mocks.revokeRefreshToken ?? vi.fn(),
    refreshAccessToken: vi.fn(),
  }))

  vi.doMock('../src/services/hubspot-contacts.js', () => ({
    upsertHubspotContact: vi.fn(),
  }))

  vi.doMock('../src/lib/hubspot-crypto.js', () => ({
    encryptHubspotToken: mocks.encryptHubspotToken ?? vi.fn((plain: string) => `enc:${plain}`),
    decryptHubspotToken: mocks.decryptHubspotToken ?? vi.fn((stored: string) => String(stored).replace(/^enc:/, '')),
    // config.ts (imported transitively by routes/hubspot.ts) also reads
    // this from the real hubspot-crypto.js — needed here too so the mock
    // fully replaces the module rather than leaving one export undefined.
    parseHubspotEncryptionKey: (raw: string | undefined) => (raw ? Buffer.from(raw, 'base64') : undefined),
  }))

  return import('../src/routes/hubspot.js')
}

describe('handleOauthCallback', () => {
  it('stores the connection and returns "connected" for a valid, complete flow (fresh connect, no prior connection)', async () => {
    const consumeOauthState = vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
    const upsertConnection = vi.fn().mockResolvedValue({})
    const requireOrganizationMembership = vi.fn().mockResolvedValue('admin')
    const exchangeCodeForTokens = vi.fn().mockResolvedValue({ accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresInSeconds: 1800 })
    const fetchHubPortalId = vi.fn().mockResolvedValue('12345678')
    const getConnection = vi.fn().mockResolvedValue(null)
    const deleteContactLinksForOrganization = vi.fn().mockResolvedValue(undefined)

    const { handleOauthCallback } = await loadRoutesWithMocks({
      consumeOauthState,
      upsertConnection,
      requireOrganizationMembership,
      exchangeCodeForTokens,
      fetchHubPortalId,
      getConnection,
      deleteContactLinksForOrganization,
    })

    const status = await handleOauthCallback({ state: 'fake-state', code: 'fake-code' })
    expect(status).toBe('connected')
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', connectedBy: 'user-1', hubPortalId: '12345678' }),
    )
    // Self-healing clear — no prior connection existed, so any orphaned
    // links (e.g. from a disconnect whose own cleanup previously failed)
    // are defensively cleared before the fresh connection is stored.
    expect(deleteContactLinksForOrganization).toHaveBeenCalledWith('org-1')
  })

  it('PORTAL BINDING: reconnecting to a DIFFERENT portal (no disconnect in between) clears the organization\'s contact links before storing the new connection', async () => {
    const consumeOauthState = vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
    const upsertConnection = vi.fn().mockResolvedValue({})
    const exchangeCodeForTokens = vi.fn().mockResolvedValue({ accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresInSeconds: 1800 })
    const fetchHubPortalId = vi.fn().mockResolvedValue('NEW-PORTAL-999') // different from the existing connection below
    const getConnection = vi.fn().mockResolvedValue({ organization_id: 'org-1', hub_portal_id: 'OLD-PORTAL-111' })
    const deleteContactLinksForOrganization = vi.fn().mockResolvedValue(undefined)

    const { handleOauthCallback } = await loadRoutesWithMocks({
      consumeOauthState,
      upsertConnection,
      exchangeCodeForTokens,
      fetchHubPortalId,
      getConnection,
      deleteContactLinksForOrganization,
    })

    const status = await handleOauthCallback({ state: 'fake-state', code: 'fake-code' })
    expect(status).toBe('connected')
    expect(deleteContactLinksForOrganization).toHaveBeenCalledWith('org-1')
    // Cleared BEFORE the new connection overwrites the old portal id.
    const clearOrder = deleteContactLinksForOrganization.mock.invocationCallOrder[0]
    const upsertOrder = upsertConnection.mock.invocationCallOrder[0]
    expect(clearOrder).toBeLessThan(upsertOrder)
  })

  it('PORTAL BINDING: reconnecting to the SAME portal (e.g. fixing needs_reauth) does NOT clear the organization\'s contact links', async () => {
    const consumeOauthState = vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
    const upsertConnection = vi.fn().mockResolvedValue({})
    const exchangeCodeForTokens = vi.fn().mockResolvedValue({ accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresInSeconds: 1800 })
    const fetchHubPortalId = vi.fn().mockResolvedValue('SAME-PORTAL-111')
    const getConnection = vi.fn().mockResolvedValue({ organization_id: 'org-1', hub_portal_id: 'SAME-PORTAL-111' })
    const deleteContactLinksForOrganization = vi.fn().mockResolvedValue(undefined)

    const { handleOauthCallback } = await loadRoutesWithMocks({
      consumeOauthState,
      upsertConnection,
      exchangeCodeForTokens,
      fetchHubPortalId,
      getConnection,
      deleteContactLinksForOrganization,
    })

    const status = await handleOauthCallback({ state: 'fake-state', code: 'fake-code' })
    expect(status).toBe('connected')
    expect(deleteContactLinksForOrganization).not.toHaveBeenCalled()
    expect(upsertConnection).toHaveBeenCalled()
  })

  it('returns "error" and never exchanges a code when the state cannot be consumed (expired, reused, or unknown) — consumeOauthState returning null is the zero-rows case', async () => {
    const consumeOauthState = vi.fn().mockResolvedValue(null)
    const exchangeCodeForTokens = vi.fn()
    const { handleOauthCallback } = await loadRoutesWithMocks({ consumeOauthState, exchangeCodeForTokens })

    const status = await handleOauthCallback({ state: 'fake-state', code: 'fake-code' })
    expect(status).toBe('error')
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('rejects the connection when the user who started the flow is no longer owner/admin — and never exchanges a code', async () => {
    const consumeOauthState = vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
    const requireOrganizationMembership = vi.fn().mockResolvedValue('member')
    const requireAdminRole = vi.fn((role: string) => {
      if (role !== 'owner' && role !== 'admin') throw new Error('Solo el propietario o un administrador pueden realizar esta acción.')
    })
    const exchangeCodeForTokens = vi.fn()
    const upsertConnection = vi.fn()

    const { handleOauthCallback } = await loadRoutesWithMocks({
      consumeOauthState,
      requireOrganizationMembership,
      requireAdminRole,
      exchangeCodeForTokens,
      upsertConnection,
    })

    const status = await handleOauthCallback({ state: 'fake-state', code: 'fake-code' })
    expect(status).toBe('error')
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(upsertConnection).not.toHaveBeenCalled()
  })

  it('rejects the connection when the user is no longer a member of the organization at all', async () => {
    const consumeOauthState = vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
    const requireOrganizationMembership = vi.fn().mockRejectedValue(new Error('No perteneces a esta organización.'))
    const exchangeCodeForTokens = vi.fn()

    const { handleOauthCallback } = await loadRoutesWithMocks({ consumeOauthState, requireOrganizationMembership, exchangeCodeForTokens })

    const status = await handleOauthCallback({ state: 'fake-state', code: 'fake-code' })
    expect(status).toBe('error')
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('returns "error" when HubSpot reports a consent error, without attempting a code exchange', async () => {
    const consumeOauthState = vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
    const exchangeCodeForTokens = vi.fn()

    const { handleOauthCallback } = await loadRoutesWithMocks({ consumeOauthState, exchangeCodeForTokens })

    const status = await handleOauthCallback({ state: 'fake-state', error: 'access_denied' })
    expect(status).toBe('error')
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('returns "error" without ever consuming a state when no state is present at all', async () => {
    const consumeOauthState = vi.fn()
    const { handleOauthCallback } = await loadRoutesWithMocks({ consumeOauthState })

    const status = await handleOauthCallback({ code: 'fake-code' })
    expect(status).toBe('error')
    expect(consumeOauthState).not.toHaveBeenCalled()
  })
})

describe('disconnectHubspotConnection — deletes ONLY on a confirmed 2xx revoke; conserves otherwise', () => {
  it('deletes the local connection when HubSpot confirms the revoke (revoked: true), and clears the organization\'s contact links (never any real HubSpot contact)', async () => {
    const getConnection = vi.fn().mockResolvedValue({ refresh_token_encrypted: 'enc:fake-refresh' })
    const deleteConnection = vi.fn().mockResolvedValue(undefined)
    const revokeRefreshToken = vi.fn().mockResolvedValue({ revoked: true })
    const deleteContactLinksForOrganization = vi.fn().mockResolvedValue(undefined)

    const { disconnectHubspotConnection } = await loadRoutesWithMocks({
      getConnection,
      deleteConnection,
      revokeRefreshToken,
      deleteContactLinksForOrganization,
    })

    const result = await disconnectHubspotConnection('org-1')
    expect(result).toEqual({ disconnected: true, revoked: true })
    expect(deleteConnection).toHaveBeenCalledWith('org-1')
    expect(deleteContactLinksForOrganization).toHaveBeenCalledWith('org-1')
  })

  it('still reports a successful disconnect even if clearing contact links fails — the security-critical part (revoke + delete) already succeeded', async () => {
    const getConnection = vi.fn().mockResolvedValue({ refresh_token_encrypted: 'enc:fake-refresh' })
    const deleteConnection = vi.fn().mockResolvedValue(undefined)
    const revokeRefreshToken = vi.fn().mockResolvedValue({ revoked: true })
    const deleteContactLinksForOrganization = vi.fn().mockRejectedValue(new Error('transient DB error'))

    const { disconnectHubspotConnection } = await loadRoutesWithMocks({
      getConnection,
      deleteConnection,
      revokeRefreshToken,
      deleteContactLinksForOrganization,
    })

    await expect(disconnectHubspotConnection('org-1')).resolves.toEqual({ disconnected: true, revoked: true })
    expect(deleteConnection).toHaveBeenCalledWith('org-1')
  })

  it('KEEPS the connection and throws a clear, retryable error on a 404 — a 404 is never treated as proof the token is gone', async () => {
    const getConnection = vi.fn().mockResolvedValue({ refresh_token_encrypted: 'enc:fake-refresh' })
    const deleteConnection = vi.fn()
    const revokeRefreshToken = vi.fn().mockResolvedValue({ revoked: false, reason: 'http_404' })

    const { disconnectHubspotConnection } = await loadRoutesWithMocks({ getConnection, deleteConnection, revokeRefreshToken })

    await expect(disconnectHubspotConnection('org-1')).rejects.toThrow(/se conservó/)
    expect(deleteConnection).not.toHaveBeenCalled()
  })

  it('KEEPS the connection and throws a clear, retryable error on any other non-2xx response, a network error, or a timeout', async () => {
    const getConnection = vi.fn().mockResolvedValue({ refresh_token_encrypted: 'enc:fake-refresh' })
    const deleteConnection = vi.fn()
    const revokeRefreshToken = vi.fn().mockResolvedValue({ revoked: false, reason: 'timeout' })

    const { disconnectHubspotConnection } = await loadRoutesWithMocks({ getConnection, deleteConnection, revokeRefreshToken })

    await expect(disconnectHubspotConnection('org-1')).rejects.toThrow(/se conservó/)
    expect(deleteConnection).not.toHaveBeenCalled()
  })

  it('throws 404 and never attempts revocation when there is no connection to disconnect', async () => {
    const getConnection = vi.fn().mockResolvedValue(null)
    const revokeRefreshToken = vi.fn()

    const { disconnectHubspotConnection } = await loadRoutesWithMocks({ getConnection, revokeRefreshToken })

    await expect(disconnectHubspotConnection('org-1')).rejects.toThrow(/No hay ninguna conexión/)
    expect(revokeRefreshToken).not.toHaveBeenCalled()
  })

  it('KEEPS the connection when the stored refresh token cannot even be decrypted', async () => {
    const getConnection = vi.fn().mockResolvedValue({ refresh_token_encrypted: 'corrupted-ciphertext' })
    const deleteConnection = vi.fn()
    const decryptHubspotToken = vi.fn(() => {
      throw new Error('authentication failed')
    })
    const revokeRefreshToken = vi.fn()

    const { disconnectHubspotConnection } = await loadRoutesWithMocks({ getConnection, deleteConnection, decryptHubspotToken, revokeRefreshToken })

    await expect(disconnectHubspotConnection('org-1')).rejects.toThrow(/se conservó/)
    expect(deleteConnection).not.toHaveBeenCalled()
    expect(revokeRefreshToken).not.toHaveBeenCalled()
  })
})

// getLeadHubspotContactLink() backs GET /leads/:leadId/contact-link — the
// read-only sync-status endpoint. Deliberately calls ONLY
// requireOrganizationMembership(), never requireEditorRole()/
// requireAdminRole(), since every role (viewer included) may read this.
describe('getLeadHubspotContactLink — read-only sync status, any role, org+lead scoped', () => {
  it('returns the mapped, camelCased status for an authorized member', async () => {
    const requireOrganizationMembership = vi.fn().mockResolvedValue('member')
    const getContactLink = vi.fn().mockResolvedValue({
      id: 'link-1',
      organization_id: 'org-1',
      lead_id: 'lead-1',
      hubspot_contact_id: 'hs-contact-1',
      last_synced_at: '2026-01-01T00:00:00.000Z',
      last_sync_status: 'synced',
      last_sync_error: null,
      created_at: '2026-01-01T00:00:00.000Z',
    })

    const { getLeadHubspotContactLink } = await loadRoutesWithMocks({ requireOrganizationMembership, getContactLink })
    const result = await getLeadHubspotContactLink('user-1', 'org-1', 'lead-1')

    expect(getContactLink).toHaveBeenCalledWith('org-1', 'lead-1')
    expect(result).toEqual({
      hubspotContactId: 'hs-contact-1',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      lastSyncStatus: 'synced',
      lastSyncError: null,
    })
    // Never leaks the row's internal id, organization_id, lead_id, or created_at.
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('organizationId')
    expect(result).not.toHaveProperty('leadId')
    expect(result).not.toHaveProperty('createdAt')
  })

  it('allows a viewer to read — no requireEditorRole/requireAdminRole gate on this endpoint', async () => {
    const requireOrganizationMembership = vi.fn().mockResolvedValue('viewer')
    const getContactLink = vi.fn().mockResolvedValue(null)

    const { getLeadHubspotContactLink } = await loadRoutesWithMocks({ requireOrganizationMembership, getContactLink })
    const result = await getLeadHubspotContactLink('user-1', 'org-1', 'lead-1')

    expect(requireOrganizationMembership).toHaveBeenCalledWith('user-1', 'org-1')
    expect(result).toBeNull()
  })

  it('returns null (never an error) for a lead that has never been synced', async () => {
    const getContactLink = vi.fn().mockResolvedValue(null)
    const { getLeadHubspotContactLink } = await loadRoutesWithMocks({ getContactLink })

    await expect(getLeadHubspotContactLink('user-1', 'org-1', 'lead-1')).resolves.toBeNull()
  })

  it('never leaks another organization\'s link: a lead/organization pair that does not match returns null, delegated to getContactLink\'s own org+lead scoped query', async () => {
    // getContactLink() itself filters on organization_id AND lead_id together
    // (see hubspot-repository.ts) — a mismatched pair simply finds no row.
    // This test pins the CONTRACT: getLeadHubspotContactLink() must pass
    // both values through untouched, and must treat "no row" as null, never
    // as an error or as data belonging to some other scope.
    const getContactLink = vi.fn().mockResolvedValue(null)
    const { getLeadHubspotContactLink } = await loadRoutesWithMocks({ getContactLink })

    const result = await getLeadHubspotContactLink('user-1', 'org-A', 'lead-from-org-B')

    expect(getContactLink).toHaveBeenCalledWith('org-A', 'lead-from-org-B')
    expect(result).toBeNull()
  })

  it('rejects and never calls getContactLink when the caller is not a member of the organization at all', async () => {
    const requireOrganizationMembership = vi.fn().mockRejectedValue(new Error('No perteneces a esta organización.'))
    const getContactLink = vi.fn()

    const { getLeadHubspotContactLink } = await loadRoutesWithMocks({ requireOrganizationMembership, getContactLink })

    await expect(getLeadHubspotContactLink('user-1', 'org-1', 'lead-1')).rejects.toThrow(/no perteneces/i)
    expect(getContactLink).not.toHaveBeenCalled()
  })
})
