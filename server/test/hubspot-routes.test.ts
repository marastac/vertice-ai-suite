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
  vi.doUnmock('../src/services/webhook-auth.js')
  vi.doUnmock('../src/lib/hubspot-crypto.js')
})

interface Mocks {
  consumeOauthState?: ReturnType<typeof vi.fn>
  upsertConnection?: ReturnType<typeof vi.fn>
  getConnection?: ReturnType<typeof vi.fn>
  deleteConnection?: ReturnType<typeof vi.fn>
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
      getConnection: mocks.getConnection ?? vi.fn(),
      deleteConnection: mocks.deleteConnection ?? vi.fn().mockResolvedValue(undefined),
      getPublicConnection: vi.fn(),
      setNeedsReauth: vi.fn(),
      getContactLink: vi.fn(),
      upsertContactLink: vi.fn(),
      createOauthState: vi.fn(),
    },
  }))

  vi.doMock('../src/services/webhook-auth.js', () => ({
    requireAuthenticatedUser: vi.fn(),
    requireOrganizationMembership: mocks.requireOrganizationMembership ?? vi.fn().mockResolvedValue('owner'),
    requireAdminRole: mocks.requireAdminRole ?? vi.fn(),
  }))

  vi.doMock('../src/services/hubspot-oauth.js', () => ({
    buildAuthorizeUrl: vi.fn(),
    exchangeCodeForTokens: mocks.exchangeCodeForTokens ?? vi.fn(),
    fetchHubPortalId: mocks.fetchHubPortalId ?? vi.fn(),
    revokeRefreshToken: mocks.revokeRefreshToken ?? vi.fn(),
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
  it('stores the connection and returns "connected" for a valid, complete flow', async () => {
    const consumeOauthState = vi.fn().mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
    const upsertConnection = vi.fn().mockResolvedValue({})
    const requireOrganizationMembership = vi.fn().mockResolvedValue('admin')
    const exchangeCodeForTokens = vi.fn().mockResolvedValue({ accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresInSeconds: 1800 })
    const fetchHubPortalId = vi.fn().mockResolvedValue('12345678')

    const { handleOauthCallback } = await loadRoutesWithMocks({
      consumeOauthState,
      upsertConnection,
      requireOrganizationMembership,
      exchangeCodeForTokens,
      fetchHubPortalId,
    })

    const status = await handleOauthCallback({ state: 'fake-state', code: 'fake-code' })
    expect(status).toBe('connected')
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', connectedBy: 'user-1', hubPortalId: '12345678' }),
    )
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
  it('deletes the local connection when HubSpot confirms the revoke (revoked: true)', async () => {
    const getConnection = vi.fn().mockResolvedValue({ refresh_token_encrypted: 'enc:fake-refresh' })
    const deleteConnection = vi.fn().mockResolvedValue(undefined)
    const revokeRefreshToken = vi.fn().mockResolvedValue({ revoked: true })

    const { disconnectHubspotConnection } = await loadRoutesWithMocks({ getConnection, deleteConnection, revokeRefreshToken })

    const result = await disconnectHubspotConnection('org-1')
    expect(result).toEqual({ disconnected: true, revoked: true })
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
