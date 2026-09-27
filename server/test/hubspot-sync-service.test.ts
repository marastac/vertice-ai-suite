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
  updateHubspotContactById?: ReturnType<typeof vi.fn>
  decryptHubspotToken?: ReturnType<typeof vi.fn>
  encryptHubspotToken?: ReturnType<typeof vi.fn>
}

const EXISTING_LINK = {
  id: 'link-1',
  organization_id: 'org-1',
  lead_id: 'lead-1',
  hubspot_contact_id: 'hs-existing-contact',
  last_synced_at: '2026-01-01T00:00:00.000Z',
  last_sync_status: 'synced' as const,
  last_sync_error: null,
  created_at: '2026-01-01T00:00:00.000Z',
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
    updateHubspotContactById:
      mocks.updateHubspotContactById ?? vi.fn().mockResolvedValue({ outcome: 'updated', hubspotContactId: EXISTING_LINK.hubspot_contact_id }),
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
  it('FIRST sync (no existing link): upserts by email — never calls updateHubspotContactById', async () => {
    const getContactLink = vi.fn().mockResolvedValue(null)
    const refreshAccessToken = vi.fn()
    const upsertHubspotContact = vi.fn().mockResolvedValue({ hubspotContactId: 'hs-contact-1' })
    const updateHubspotContactById = vi.fn()
    const upsertContactLink = vi.fn().mockResolvedValue({})

    const { syncLeadToHubspot } = await loadServiceWithMocks({
      getContactLink,
      refreshAccessToken,
      upsertHubspotContact,
      updateHubspotContactById,
      upsertContactLink,
    })
    const result = await syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })

    expect(result.hubspotContactId).toBe('hs-contact-1')
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(updateHubspotContactById).not.toHaveBeenCalled()
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

// RESYNC — an existing hubspot_contact_links row is present. This is the
// fix for the confirmed email-change defect: identifying the contact by
// its known id (never by email again) so a lead's email can change and a
// resync still updates the SAME HubSpot contact.
describe('syncLeadToHubspot — resync with an existing link (update by id, never by email again)', () => {
  it('SECOND sync (link exists): updates by hubspot_contact_id — never re-identifies by email', async () => {
    const getContactLink = vi.fn().mockResolvedValue(EXISTING_LINK)
    const updateHubspotContactById = vi.fn().mockResolvedValue({ outcome: 'updated', hubspotContactId: EXISTING_LINK.hubspot_contact_id })
    const upsertHubspotContact = vi.fn()
    const upsertContactLink = vi.fn().mockResolvedValue({})

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink, updateHubspotContactById, upsertHubspotContact, upsertContactLink })
    const result = await syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })

    expect(updateHubspotContactById).toHaveBeenCalledWith(
      'fresh-access-token',
      EXISTING_LINK.hubspot_contact_id,
      expect.objectContaining({ email: 'ana@example.test' }),
    )
    expect(upsertHubspotContact).not.toHaveBeenCalled()
    expect(result.hubspotContactId).toBe(EXISTING_LINK.hubspot_contact_id)
    expect(upsertContactLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      leadId: 'lead-1',
      hubspotContactId: EXISTING_LINK.hubspot_contact_id,
      status: 'synced',
      error: null,
    })
  })

  it('a changed email updates the SAME contact by id — never creates/finds a different one by the new email', async () => {
    // The lead's CURRENT email differs from whatever it was when it first
    // synced — updateHubspotContactById() is still called with the SAME
    // known contact id, and its properties simply carry the new email as a
    // property to SET, never as a lookup key.
    const changedEmailLead = { ...VALID_LEAD, email: 'ana.nueva@example.test' }
    const getContactLink = vi.fn().mockResolvedValue(EXISTING_LINK)
    const getLeadForSync = vi.fn().mockResolvedValue(changedEmailLead)
    const updateHubspotContactById = vi.fn().mockResolvedValue({ outcome: 'updated', hubspotContactId: EXISTING_LINK.hubspot_contact_id })
    const upsertHubspotContact = vi.fn()

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink, getLeadForSync, updateHubspotContactById, upsertHubspotContact })
    const result = await syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })

    expect(updateHubspotContactById).toHaveBeenCalledWith(
      'fresh-access-token',
      EXISTING_LINK.hubspot_contact_id, // identified by id, not by the new email
      expect.objectContaining({ email: 'ana.nueva@example.test' }),
    )
    expect(upsertHubspotContact).not.toHaveBeenCalled()
    expect(result.hubspotContactId).toBe(EXISTING_LINK.hubspot_contact_id)
  })

  it('falls back to upsert-by-email when the known contact was deleted in HubSpot (not_found), and saves the NEW id', async () => {
    const getContactLink = vi.fn().mockResolvedValue(EXISTING_LINK)
    const updateHubspotContactById = vi.fn().mockResolvedValue({ outcome: 'not_found' })
    const upsertHubspotContact = vi.fn().mockResolvedValue({ hubspotContactId: 'hs-brand-new-contact' })
    const upsertContactLink = vi.fn().mockResolvedValue({})

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink, updateHubspotContactById, upsertHubspotContact, upsertContactLink })
    const result = await syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })

    expect(updateHubspotContactById).toHaveBeenCalledWith('fresh-access-token', EXISTING_LINK.hubspot_contact_id, expect.anything())
    expect(upsertHubspotContact).toHaveBeenCalledWith('fresh-access-token', expect.objectContaining({ email: 'ana@example.test' }))
    expect(result.hubspotContactId).toBe('hs-brand-new-contact')
    expect(upsertContactLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      leadId: 'lead-1',
      hubspotContactId: 'hs-brand-new-contact', // the link now points to the NEW id, not the stale one
      status: 'synced',
      error: null,
    })
  })

  it('on a CONFLICT (new email collides with a different contact): never falls back, never creates another contact, never changes the stored id', async () => {
    const getContactLink = vi.fn().mockResolvedValue(EXISTING_LINK)
    const updateHubspotContactById = vi.fn().mockResolvedValue({ outcome: 'conflict', message: 'Ya existe otro contacto en HubSpot con ese correo electrónico.' })
    const upsertHubspotContact = vi.fn()
    const upsertContactLink = vi.fn().mockResolvedValue({})

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink, updateHubspotContactById, upsertHubspotContact, upsertContactLink })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow(/ya existe otro contacto/i)
    expect(upsertHubspotContact).not.toHaveBeenCalled()
    // The ORIGINAL contact id is preserved — status flips to 'failed', but
    // hubspot_contact_id is NEVER replaced by anything else.
    expect(upsertContactLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      leadId: 'lead-1',
      hubspotContactId: EXISTING_LINK.hubspot_contact_id,
      status: 'failed',
      error: expect.stringMatching(/ya existe otro contacto/i),
    })
  })

  it('on a timeout/network error updating by id: never falls back to email upsert, and the existing link is preserved (marked failed, same id)', async () => {
    const getContactLink = vi.fn().mockResolvedValue(EXISTING_LINK)
    const updateHubspotContactById = vi.fn().mockRejectedValue(new AppError(504, 'Se agotó el tiempo de espera al sincronizar con HubSpot.'))
    const upsertHubspotContact = vi.fn()
    const upsertContactLink = vi.fn().mockResolvedValue({})

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink, updateHubspotContactById, upsertHubspotContact, upsertContactLink })

    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow()
    expect(upsertHubspotContact).not.toHaveBeenCalled()
    expect(upsertContactLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      leadId: 'lead-1',
      hubspotContactId: EXISTING_LINK.hubspot_contact_id,
      status: 'failed',
      error: expect.any(String),
    })
  })

  it('never leaks the lead email/phone into logs when a conflict or timeout occurs during a resync', async () => {
    const loggerErrorSpy = vi.fn()
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: loggerErrorSpy } }))
    const getContactLink = vi.fn().mockResolvedValue(EXISTING_LINK)
    const updateHubspotContactById = vi.fn().mockRejectedValue(new AppError(502, 'No se pudo sincronizar el lead con HubSpot.'))

    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink, updateHubspotContactById })
    await expect(syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })).rejects.toThrow()

    const loggedText = JSON.stringify([...loggerErrorSpy.mock.calls, ...loggerWarnSpy.mock.calls])
    expect(loggedText).not.toContain(VALID_LEAD.email)
    expect(loggedText).not.toContain(VALID_LEAD.phone)

    vi.doUnmock('../src/lib/logger.js')
  })

  it('multi-tenant: resync decision reads the link scoped to THIS organizationId/leadId only', async () => {
    const getContactLink = vi.fn().mockResolvedValue(EXISTING_LINK)
    const { syncLeadToHubspot } = await loadServiceWithMocks({ getContactLink })

    await syncLeadToHubspot({ organizationId: 'org-1', leadId: 'lead-1' })

    expect(getContactLink).toHaveBeenCalledWith('org-1', 'lead-1')
  })
})
