import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../src/lib/errors.js'

// syncLeadToHubspot() is the orchestrator behind POST
// /api/hubspot/leads/:leadId/sync — extracted into its own service
// specifically so it's testable without an HTTP harness (this project has
// none), same reasoning as routes/hubspot.ts's handleOauthCallback()/
// disconnectHubspotConnection(). Every real dependency (repository, HubSpot
// OAuth refresh, the Contacts API client, encryption) is mocked via
// vi.doMock() so these tests exercise only the service's own decision
// logic.

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
  vi.doUnmock('../src/lib/hubspot-crypto.js')
})

const FRESH_CONNECTION = {
  organization_id: 'org-1',
  hub_portal_id: '12345678',
  access_token_encrypted: 'enc:fresh-access-token',
  refresh_token_encrypted: 'enc:fresh-refresh-token',
  access_token_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), // 1h out — well past the refresh buffer
  scopes: 'crm.objects.contacts.write',
  needs_reauth: false,
  connected_by: 'user-1',
}

const EXPIRED_CONNECTION = {
  ...FRESH_CONNECTION,
  access_token_encrypted: 'enc:stale-access-token',
  refresh_token_encrypted: 'enc:stale-refresh-token',
  access_token_expires_at: new Date(Date.now() - 60_000).toISOString(), // already expired
}

const VALID_LEAD = { id: 'lead-1', name: 'Ana García', email: 'ana@example.test', phone: '+34123456789', company: 'Acme' }

interface Mocks {
  getConnection?: ReturnType<typeof vi.fn>
  getLeadForSync?: ReturnType<typeof vi.fn>
  updateTokensAfterRefresh?: ReturnType<typeof vi.fn>
  setNeedsReauth?: ReturnType<typeof vi.fn>
  getContactLink?: ReturnType<typeof vi.fn>
  upsertContactLink?: ReturnType<typeof vi.fn>
  refreshAccessToken?: ReturnType<typeof vi.fn>
  upsertHubspotContact?: ReturnType<typeof vi.fn>
  decryptHubspotToken?: ReturnType<typeof vi.fn>
  encryptHubspotToken?: ReturnType<typeof vi.fn>
}

async function loadServiceWithMocks(mocks: Mocks) {
  vi.resetModules()

  vi.doMock('../src/repositories/hubspot-repository.js', () => ({
    hubspotRepository: {
      getConnection: mocks.getConnection ?? vi.fn().mockResolvedValue(FRESH_CONNECTION),
      getLeadForSync: mocks.getLeadForSync ?? vi.fn().mockResolvedValue(VALID_LEAD),
      updateTokensAfterRefresh: mocks.updateTokensAfterRefresh ?? vi.fn().mockResolvedValue(undefined),
      setNeedsReauth: mocks.setNeedsReauth ?? vi.fn().mockResolvedValue(undefined),
      getContactLink: mocks.getContactLink ?? vi.fn().mockResolvedValue(null),
      upsertContactLink: mocks.upsertContactLink ?? vi.fn().mockResolvedValue({}),
    },
  }))

  vi.doMock('../src/services/hubspot-oauth.js', () => ({
    refreshAccessToken: mocks.refreshAccessToken ?? vi.fn(),
    // Real implementation, duplicated here rather than imported — same
    // convention already used for parseHubspotEncryptionKey in
    // hubspot-routes.test.ts's hubspot-crypto mock. Duck-typed on `.reason`
    // exactly like the real hubspot-oauth.ts export, so a test can simulate
    // a "rejected" vs. "timeout"/"network_error" refresh failure just by
    // attaching a `.reason` to the value refreshAccessToken rejects with.
    isDefinitiveAuthRejection: (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'rejected',
  }))

  vi.doMock('../src/services/hubspot-contacts.js', () => ({
    upsertHubspotContact: mocks.upsertHubspotContact ?? vi.fn().mockResolvedValue({ hubspotContactId: 'hs-contact-1' }),
  }))

  vi.doMock('../src/lib/hubspot-crypto.js', () => ({
    encryptHubspotToken: mocks.encryptHubspotToken ?? vi.fn((plain: string) => `enc:${plain}`),
    decryptHubspotToken: mocks.decryptHubspotToken ?? vi.fn((stored: string) => String(stored).replace(/^enc:/, '')),
    parseHubspotEncryptionKey: (raw: string | undefined) => (raw ? Buffer.from(raw, 'base64') : undefined),
  }))

  return import('../src/services/hubspot-sync-service.js')
}

describe('splitLeadName', () => {
  it('splits on the first space into firstname/lastname', async () => {
    const { splitLeadName } = await loadServiceWithMocks({})
    expect(splitLeadName('Ana García López')).toEqual({ firstname: 'Ana', lastname: 'García López' })
  })

  it('returns only firstname for a single-word name, never a fabricated empty lastname', async () => {
    const { splitLeadName } = await loadServiceWithMocks({})
    expect(splitLeadName('Cher')).toEqual({ firstname: 'Cher' })
  })
})

describe('mapLeadToHubspotProperties', () => {
  it('maps only fields that exist on the Lead model', async () => {
    const { mapLeadToHubspotProperties } = await loadServiceWithMocks({})
    expect(mapLeadToHubspotProperties(VALID_LEAD)).toEqual({
      email: 'ana@example.test',
      firstname: 'Ana',
      lastname: 'García',
      phone: '+34123456789',
      company: 'Acme',
    })
  })

  it('omits phone when the lead has none', async () => {
    const { mapLeadToHubspotProperties } = await loadServiceWithMocks({})
    expect(mapLeadToHubspotProperties({ ...VALID_LEAD, phone: null }).phone).toBeUndefined()
  })
})

describe('syncLeadToHubspot', () => {
  it('syncs successfully with a still-fresh access token — never calls refreshAccessToken', async () => {
    const refreshAccessToken = vi.fn()
    const upsertHubspotContact = vi.fn().mockResolvedValue({ hubspotContactId: 'hs-contact-1' })
    const upsertContactLink = vi.fn().mockResolvedValue({})

    const { syncLeadToHubspot } = await loadServiceWithMocks({ refreshAccessToken, upsertHubspotContact, upsertContactLink })
    const result = await syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })

    expect(result.hubspotContactId).toBe('hs-contact-1')
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(upsertHubspotContact).toHaveBeenCalledWith('fresh-access-token', {
      email: 'ana@example.test',
      firstname: 'Ana',
      lastname: 'García',
      phone: '+34123456789',
      company: 'Acme',
    })
    expect(upsertContactLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      leadId: 'lead-1',
      hubspotContactId: 'hs-contact-1',
      status: 'synced',
      error: null,
    })
  })

  it('refreshes the token first when the stored one is expired, then syncs', async () => {
    const getConnection = vi.fn().mockResolvedValue(EXPIRED_CONNECTION)
    const refreshAccessToken = vi.fn().mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresInSeconds: 1800 })
    const updateTokensAfterRefresh = vi.fn().mockResolvedValue(undefined)
    const upsertHubspotContact = vi.fn().mockResolvedValue({ hubspotContactId: 'hs-contact-2' })

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getConnection, refreshAccessToken, updateTokensAfterRefresh, upsertHubspotContact })
    const result = await syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })

    expect(refreshAccessToken).toHaveBeenCalledWith('stale-refresh-token')
    expect(updateTokensAfterRefresh).toHaveBeenCalledWith('org-1', {
      accessTokenEncrypted: 'enc:new-access',
      refreshTokenEncrypted: 'enc:new-refresh',
      accessTokenExpiresAt: expect.any(String),
    })
    expect(upsertHubspotContact).toHaveBeenCalledWith('new-access', expect.anything())
    expect(result.hubspotContactId).toBe('hs-contact-2')
  })

  it('preserves the previous refresh token when HubSpot does not return a new one — never null', async () => {
    const getConnection = vi.fn().mockResolvedValue(EXPIRED_CONNECTION)
    const refreshAccessToken = vi.fn().mockResolvedValue({ accessToken: 'new-access', refreshToken: null, expiresInSeconds: 1800 })
    const updateTokensAfterRefresh = vi.fn().mockResolvedValue(undefined)

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getConnection, refreshAccessToken, updateTokensAfterRefresh })
    await syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })

    expect(updateTokensAfterRefresh).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ refreshTokenEncrypted: EXPIRED_CONNECTION.refresh_token_encrypted }),
    )
  })

  it('marks needs_reauth=true and throws when HubSpot definitively rejects the refresh (invalid/revoked refresh token) — never calls the Contacts API', async () => {
    const getConnection = vi.fn().mockResolvedValue(EXPIRED_CONNECTION)
    const refreshAccessToken = vi.fn().mockRejectedValue(Object.assign(new Error('HubSpot rechazó la solicitud.'), { reason: 'rejected' }))
    const setNeedsReauth = vi.fn().mockResolvedValue(undefined)
    const upsertHubspotContact = vi.fn()

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getConnection, refreshAccessToken, setNeedsReauth, upsertHubspotContact })

    // Message-regex, not `instanceof AppError` — see the file-level note
    // above on why instanceof is unreliable across a vi.resetModules() re-import.
    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow(/reconéctala/i)
    expect(setNeedsReauth).toHaveBeenCalledWith('org-1', true)
    expect(upsertHubspotContact).not.toHaveBeenCalled()
  })

  it('does NOT mark needs_reauth when the refresh attempt merely times out — a timeout says nothing about the token\'s validity', async () => {
    const getConnection = vi.fn().mockResolvedValue(EXPIRED_CONNECTION)
    const refreshAccessToken = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Se agotó el tiempo de espera al contactar a HubSpot.'), { reason: 'timeout' }))
    const setNeedsReauth = vi.fn().mockResolvedValue(undefined)
    const upsertHubspotContact = vi.fn()

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getConnection, refreshAccessToken, setNeedsReauth, upsertHubspotContact })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow(/renovar la conexión/i)
    expect(setNeedsReauth).not.toHaveBeenCalled()
    expect(upsertHubspotContact).not.toHaveBeenCalled()
  })

  it('does NOT mark needs_reauth when the refresh attempt fails with a plain network error either', async () => {
    const getConnection = vi.fn().mockResolvedValue(EXPIRED_CONNECTION)
    const refreshAccessToken = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('No se pudo contactar a HubSpot.'), { reason: 'network_error' }))
    const setNeedsReauth = vi.fn().mockResolvedValue(undefined)

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getConnection, refreshAccessToken, setNeedsReauth })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow(/renovar la conexión/i)
    expect(setNeedsReauth).not.toHaveBeenCalled()
  })

  it('throws 404 when there is no HubSpot connection for the organization', async () => {
    const getConnection = vi.fn().mockResolvedValue(null)
    const getLeadForSync = vi.fn()
    const upsertHubspotContact = vi.fn()

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getConnection, getLeadForSync, upsertHubspotContact })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow(/no hay ninguna conexión/i)
    expect(getLeadForSync).not.toHaveBeenCalled()
    expect(upsertHubspotContact).not.toHaveBeenCalled()
  })

  it('rejects when the connection needs reauthorization, before ever loading the lead', async () => {
    const getConnection = vi.fn().mockResolvedValue({ ...FRESH_CONNECTION, needs_reauth: true })
    const getLeadForSync = vi.fn()

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getConnection, getLeadForSync })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow(/reautorización/i)
    expect(getLeadForSync).not.toHaveBeenCalled()
  })

  it('throws 404 when the lead does not exist for this organization (also covers a lead belonging to a different organization)', async () => {
    const getLeadForSync = vi.fn().mockResolvedValue(null)
    const upsertHubspotContact = vi.fn()

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getLeadForSync, upsertHubspotContact })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-from-another-org' })).rejects.toThrow(/no encontrado/i)
    expect(upsertHubspotContact).not.toHaveBeenCalled()
  })

  it('rejects a lead with no valid email without ever calling HubSpot', async () => {
    const getLeadForSync = vi.fn().mockResolvedValue({ ...VALID_LEAD, email: 'not-an-email' })
    const refreshAccessToken = vi.fn()
    const upsertHubspotContact = vi.fn()

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getLeadForSync, refreshAccessToken, upsertHubspotContact })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow(/correo electrónico válido/i)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(upsertHubspotContact).not.toHaveBeenCalled()
  })

  it('records a failed sync against an existing link row, keeping its previous contact id', async () => {
    const getContactLink = vi.fn().mockResolvedValue({ hubspot_contact_id: 'hs-previous-contact' })
    const upsertContactLink = vi.fn().mockResolvedValue({})
    const upsertHubspotContact = vi.fn().mockRejectedValue(new AppError(502, 'HubSpot rechazó la sincronización del contacto.'))

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink, upsertContactLink, upsertHubspotContact })

    // The rejection here originates from a mock (upsertHubspotContact)
    // built with THIS test file's own AppError import, then re-thrown from
    // inside the freshly re-imported service module — its own `instanceof
    // AppError` check therefore doesn't recognize it as one (cross-module
    // identity, same caveat as above), so it falls back to a generic
    // message. Either way it's a rejection; the exact wording isn't the
    // point of this test — the link-recording behavior below is.
    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow()
    expect(upsertContactLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      leadId: 'lead-1',
      hubspotContactId: 'hs-previous-contact',
      status: 'failed',
      error: expect.any(String),
    })
  })

  it('writes no link row for a first-ever failure with no prior successful sync (hubspot_contact_id is NOT NULL)', async () => {
    const getContactLink = vi.fn().mockResolvedValue(null)
    const upsertContactLink = vi.fn()
    const upsertHubspotContact = vi.fn().mockRejectedValue(new AppError(502, 'HubSpot rechazó la sincronización del contacto.'))

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink, upsertContactLink, upsertHubspotContact })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow()
    expect(upsertContactLink).not.toHaveBeenCalled()
  })

  it('never logs the lead email/phone or any token material when recording a failure', async () => {
    const loggerErrorSpy = vi.fn()
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: loggerErrorSpy } }))
    const upsertHubspotContact = vi.fn().mockRejectedValue(new AppError(502, 'HubSpot rechazó la sincronización del contacto.'))

    const { syncLeadToHubspot } = await loadServiceWithMocks({ upsertHubspotContact })
    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow()

    const loggedText = JSON.stringify([...loggerErrorSpy.mock.calls, ...loggerWarnSpy.mock.calls])
    expect(loggedText).not.toContain(VALID_LEAD.email)
    expect(loggedText).not.toContain(VALID_LEAD.phone)
    expect(loggedText).not.toContain('fresh-access-token')
    expect(loggedText).not.toContain('fresh-refresh-token')

    vi.doUnmock('../src/lib/logger.js')
  })
})
