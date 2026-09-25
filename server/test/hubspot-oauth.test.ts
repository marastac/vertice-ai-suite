import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Obviously-fake, valid-shaped placeholders — never real HubSpot
// credentials. Only used to exercise config.isHubspotConfigured's gate and
// to build predictable URLs; hubspot-oauth.ts never logs or returns these.
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
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** Re-imports hubspot-oauth.ts (and the config.ts it reads at module load) fresh, with the given env applied — the only way to exercise config.isHubspotConfigured in both states without a live server. */
async function loadWithEnv(overrides: Partial<typeof FAKE_ENV> & { unset?: (keyof typeof FAKE_ENV)[] } = {}) {
  vi.resetModules()
  for (const key of ENV_KEYS) process.env[key] = FAKE_ENV[key]
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'unset') continue
    process.env[key as keyof typeof FAKE_ENV] = value as string
  }
  for (const key of overrides.unset ?? []) delete process.env[key]
  return import('../src/services/hubspot-oauth.js')
}

function stubFetchOnce(impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  const fetchMock = vi.fn(impl)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('buildAuthorizeUrl', () => {
  it('includes client_id, redirect_uri, scope, and state — never the client secret', async () => {
    const { buildAuthorizeUrl } = await loadWithEnv()
    const url = new URL(buildAuthorizeUrl('fake-state-value'))
    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe(FAKE_ENV.HUBSPOT_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(FAKE_ENV.HUBSPOT_REDIRECT_URI)
    expect(url.searchParams.get('scope')).toBe('crm.objects.contacts.write')
    expect(url.searchParams.get('state')).toBe('fake-state-value')
    expect(url.toString()).not.toContain(FAKE_ENV.HUBSPOT_CLIENT_SECRET)
  })

  it('throws when HubSpot is not configured', async () => {
    const { buildAuthorizeUrl } = await loadWithEnv({ unset: ['HUBSPOT_CLIENT_ID'] })
    expect(() => buildAuthorizeUrl('fake-state')).toThrow(/no está configurada/)
  })
})

describe('exchangeCodeForTokens — validates the HubSpot response before trusting it', () => {
  it('succeeds and returns the parsed tokens for a well-formed response', async () => {
    const { exchangeCodeForTokens } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(200, { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 1800 }))
    const result = await exchangeCodeForTokens('fake-code')
    expect(result).toEqual({ accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresInSeconds: 1800 })
  })

  it('rejects a response missing access_token', async () => {
    const { exchangeCodeForTokens } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(200, { refresh_token: 'fake-refresh', expires_in: 1800 }))
    await expect(exchangeCodeForTokens('fake-code')).rejects.toThrow(/token de acceso/)
  })

  it('rejects a response missing refresh_token', async () => {
    const { exchangeCodeForTokens } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(200, { access_token: 'fake-access', expires_in: 1800 }))
    await expect(exchangeCodeForTokens('fake-code')).rejects.toThrow(/token de actualización/)
  })

  it('rejects a response with a non-numeric or non-positive expires_in', async () => {
    const { exchangeCodeForTokens } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 0 }))
    await expect(exchangeCodeForTokens('fake-code')).rejects.toThrow(/expiración/)
  })

  it('rejects when HubSpot returns a non-OK HTTP status', async () => {
    const { exchangeCodeForTokens } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(400, { error: 'invalid_grant' }))
    await expect(exchangeCodeForTokens('fake-code')).rejects.toThrow(/rechazó la solicitud/)
  })

  it('rejects when the network request itself fails', async () => {
    const { exchangeCodeForTokens } = await loadWithEnv()
    stubFetchOnce(async () => {
      throw new Error('ECONNRESET (simulated, never a real network condition)')
    })
    await expect(exchangeCodeForTokens('fake-code')).rejects.toThrow(/no se pudo contactar/i)
  })

  it('throws when HubSpot is not configured', async () => {
    const { exchangeCodeForTokens } = await loadWithEnv({ unset: ['HUBSPOT_CLIENT_SECRET'] })
    await expect(exchangeCodeForTokens('fake-code')).rejects.toThrow(/no está configurada/)
  })
})

describe('refreshAccessToken — preserves-or-null refresh token behavior', () => {
  it('returns the new refresh token when HubSpot includes one', async () => {
    const { refreshAccessToken } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 1800 }))
    const result = await refreshAccessToken('old-refresh')
    expect(result.refreshToken).toBe('new-refresh')
  })

  it('returns null (never a fabricated value) when HubSpot omits refresh_token', async () => {
    const { refreshAccessToken } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(200, { access_token: 'new-access', expires_in: 1800 }))
    const result = await refreshAccessToken('old-refresh')
    expect(result.refreshToken).toBeNull()
    expect(result.accessToken).toBe('new-access')
  })
})

describe('fetchHubPortalId', () => {
  it('returns the hub_id as a string when present (numeric)', async () => {
    const { fetchHubPortalId } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(200, { hub_id: 12345678 }))
    await expect(fetchHubPortalId('fake-token')).resolves.toBe('12345678')
  })

  it('rejects a response with no hub_id', async () => {
    const { fetchHubPortalId } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(200, { scopes: ['crm.objects.contacts.write'] }))
    await expect(fetchHubPortalId('fake-token')).rejects.toThrow(/portal/)
  })
})

describe('revokeRefreshToken — never throws; only a confirmed 2xx counts as revoked', () => {
  it('calls the documented URL with client_id, client_secret, token, and token_type_hint=refresh_token — never anything else', async () => {
    const { revokeRefreshToken } = await loadWithEnv()
    const fetchMock = stubFetchOnce(async () => new Response(null, { status: 204 }))

    await revokeRefreshToken('fake-refresh-token-value')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.hubapi.com/oauth/2026-09/token/revoke')
    expect(options.method).toBe('POST')
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')

    const sentBody = new URLSearchParams(options.body as string)
    expect(sentBody.get('client_id')).toBe('fake-client-id')
    expect(sentBody.get('client_secret')).toBe('fake-client-secret')
    expect(sentBody.get('token')).toBe('fake-refresh-token-value')
    expect(sentBody.get('token_type_hint')).toBe('refresh_token')
    // Exactly these four fields — nothing extra (e.g. no stray
    // `refresh_token` key from an earlier body shape).
    expect([...sentBody.keys()].sort()).toEqual(['client_id', 'client_secret', 'token', 'token_type_hint'])
  })

  it('resolves { revoked: true } on a successful (2xx) revoke', async () => {
    const { revokeRefreshToken } = await loadWithEnv()
    stubFetchOnce(async () => new Response(null, { status: 204 }))
    await expect(revokeRefreshToken('fake-refresh')).resolves.toEqual({ revoked: true })
  })

  it('resolves { revoked: false } (never a throw, and 404 is NOT treated as proof of revocation) on a 404', async () => {
    const { revokeRefreshToken } = await loadWithEnv()
    stubFetchOnce(async () => new Response(null, { status: 404 }))
    const result = await revokeRefreshToken('fake-refresh')
    expect(result).toEqual({ revoked: false, reason: 'http_404' })
  })

  it('resolves { revoked: false } on any other non-2xx status (e.g. 401)', async () => {
    const { revokeRefreshToken } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(401, { error: 'invalid_client' }))
    const result = await revokeRefreshToken('fake-refresh')
    expect(result).toEqual({ revoked: false, reason: 'http_401' })
  })

  it('resolves { revoked: false, reason: "network_error" } (never a throw) when the network request fails', async () => {
    const { revokeRefreshToken } = await loadWithEnv()
    stubFetchOnce(async () => {
      throw new Error('simulated network failure')
    })
    const result = await revokeRefreshToken('fake-refresh')
    expect(result).toEqual({ revoked: false, reason: 'network_error' })
  })

  it('resolves { revoked: false, reason: "timeout" } when the request is aborted (simulated timeout)', async () => {
    const { revokeRefreshToken } = await loadWithEnv()
    stubFetchOnce(async () => {
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'
      throw abortError
    })
    const result = await revokeRefreshToken('fake-refresh')
    expect(result).toEqual({ revoked: false, reason: 'timeout' })
  })

  it('never logs or exposes the client secret or the token being revoked, on any path', async () => {
    const { revokeRefreshToken } = await loadWithEnv()
    stubFetchOnce(async () => jsonResponse(401, { error: 'invalid_client' }))
    const result = await revokeRefreshToken('super-secret-refresh-token-value')
    expect(JSON.stringify(result)).not.toContain('super-secret-refresh-token-value')
    expect(JSON.stringify(result)).not.toContain(FAKE_ENV.HUBSPOT_CLIENT_SECRET)
  })

  it('resolves { revoked: false, reason: "not_configured" } without ever calling fetch when HubSpot is not configured', async () => {
    const { revokeRefreshToken } = await loadWithEnv({ unset: ['HUBSPOT_CLIENT_ID'] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await revokeRefreshToken('fake-refresh')
    expect(result).toEqual({ revoked: false, reason: 'not_configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
