import { afterEach, describe, expect, it, vi } from 'vitest'

// Assertions below match on the thrown error's MESSAGE (regex), never via
// `instanceof AppError` — each test dynamically re-imports
// hubspot-contacts.js after vi.resetModules() (see afterEach), which loads
// a fresh instance of errors.js distinct from one imported statically at
// the top of a test file; `instanceof` against that static import would
// spuriously fail even for a genuine AppError. Same convention already
// used by hubspot-routes.test.ts (e.g. `.rejects.toThrow(/se conservó/)`).

// upsertHubspotContact() is the one function that ever talks to HubSpot's
// Contacts API. These tests exercise it directly against a stubbed global
// `fetch`, mirroring hubspot-oauth.test.ts's approach for the token
// endpoints — no HTTP harness exists in this project.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.doUnmock('../src/lib/logger.js')
})

describe('upsertHubspotContact', () => {
  it('POSTs to the batch upsert endpoint with idProperty email, Bearer auth, and JSON content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'COMPLETE', results: [{ id: 'hs-contact-1' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    const result = await upsertHubspotContact('fake-access-token', { email: 'lead@example.test', firstname: 'Ana' })

    expect(result).toEqual({ hubspotContactId: 'hs-contact-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-access-token')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      inputs: [{ id: 'lead@example.test', idProperty: 'email', properties: { email: 'lead@example.test', firstname: 'Ana' } }],
    })
  })

  it('omits phone/company/lastname from the properties body when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'COMPLETE', results: [{ id: 'hs-contact-2' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await upsertHubspotContact('fake-access-token', { email: 'solo@example.test', firstname: 'Solo' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.inputs[0].properties).toEqual({ email: 'solo@example.test', firstname: 'Solo' })
    expect(body.inputs[0].properties).not.toHaveProperty('phone')
    expect(body.inputs[0].properties).not.toHaveProperty('company')
    expect(body.inputs[0].properties).not.toHaveProperty('lastname')
  })

  it('includes phone and company when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'COMPLETE', results: [{ id: 'hs-contact-3' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await upsertHubspotContact('fake-access-token', {
      email: 'full@example.test',
      firstname: 'Full',
      lastname: 'Contact',
      phone: '+34123456789',
      company: 'Acme',
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.inputs[0].properties).toEqual({
      email: 'full@example.test',
      firstname: 'Full',
      lastname: 'Contact',
      phone: '+34123456789',
      company: 'Acme',
    })
  })

  it('throws AppError(502) on a non-2xx response and never logs the response body', async () => {
    const loggerErrorSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: loggerErrorSpy } }))
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'This response mentions secret@example.test and should never be logged' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'secret@example.test' })).rejects.toThrow(/rechazó la sincronización/)

    expect(loggerErrorSpy).toHaveBeenCalled()
    const loggedText = JSON.stringify(loggerErrorSpy.mock.calls)
    expect(loggedText).not.toContain('secret@example.test')
    expect(loggedText).not.toContain('fake-access-token')
  })

  it('throws AppError(502) when the network request itself fails, without logging the access token', async () => {
    const loggerErrorSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: loggerErrorSpy } }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    )

    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/no se pudo contactar/i)

    const loggedText = JSON.stringify(loggerErrorSpy.mock.calls)
    expect(loggedText).not.toContain('fake-access-token')
  })

  it('throws AppError(502) when the response body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('not json') } }))
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/respuesta inesperada/)
  })

  it('throws AppError(502) when the response has no results array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'COMPLETE' }) }))
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/ningún resultado/)
  })

  it('throws AppError(502) when results is an empty array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'COMPLETE', results: [] }) }))
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/ningún resultado/)
  })

  it('throws AppError(502) when the first result has no usable id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'COMPLETE', results: [{}] }) }))
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/identificador de contacto válido/)
  })

  it('throws AppError(502) when the first result id is an empty string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'COMPLETE', results: [{ id: '' }] }) }))
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/identificador de contacto válido/)
  })

  it('times out (AppError 504) when the request hangs, without ever logging the access token', async () => {
    const loggerErrorSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: loggerErrorSpy } }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        const abortError = new Error('The operation was aborted')
        abortError.name = 'AbortError'
        throw abortError
      }),
    )

    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    const promise = upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })
    await expect(promise).rejects.toThrow(/tiempo de espera/i)

    const loggedText = JSON.stringify(loggerErrorSpy.mock.calls)
    expect(loggedText).not.toContain('fake-access-token')
  })

  it('rejects a status that has not completed yet (e.g. PENDING) — never treated as a success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'PENDING', results: [] }) }))
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/no completó/i)
  })

  it('rejects a CANCELED status — never treated as a success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'CANCELED', results: [] }) }))
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/no completó/i)
  })

  it('rejects a response with no status field at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ id: 'hs-1' }] }) }))
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/estado de sincronización reconocible/i)
  })

  it('rejects a 207 (HTTP-level "ok") that reports partial errors for our single input, even though status is COMPLETE and never falsely reports success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 207,
        json: async () => ({
          status: 'COMPLETE',
          results: [],
          errors: [{ status: 'error', category: 'VALIDATION_ERROR', message: 'Property "xyz" does not exist' }],
        }),
      }),
    )
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/respuesta con errores/i)
  })

  it('never logs the full errors array (only the error category) for a 207 partial-errors response', async () => {
    const loggerErrorSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: loggerErrorSpy } }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 207,
        json: async () => ({
          status: 'COMPLETE',
          results: [],
          errors: [{ status: 'error', category: 'VALIDATION_ERROR', message: 'This message mentions secret@example.test and must never be logged' }],
        }),
      }),
    )

    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow()

    const loggedText = JSON.stringify(loggerErrorSpy.mock.calls)
    expect(loggedText).toContain('VALIDATION_ERROR')
    expect(loggedText).not.toContain('secret@example.test')
  })

  it('rejects even if results is (self-contradictorily) non-empty when errors is also non-empty — no ambiguous partial success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 207,
        json: async () => ({
          status: 'COMPLETE',
          results: [{ id: 'hs-contact-unexpected' }],
          errors: [{ status: 'error', category: 'VALIDATION_ERROR' }],
        }),
      }),
    )
    const { upsertHubspotContact } = await import('../src/services/hubspot-contacts.js')
    await expect(upsertHubspotContact('fake-access-token', { email: 'lead@example.test' })).rejects.toThrow(/respuesta con errores/i)
  })
})

// updateHubspotContactById() — the by-ID update path used for every resync
// (see hubspot-sync-service.ts). Response classification is deliberately
// layered (status code OR category), never hard-coded to one exact status.
describe('updateHubspotContactById', () => {
  it('PATCHes the single-object endpoint with the contact id in the URL, Bearer auth, and JSON content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'hs-contact-1' }) })
    vi.stubGlobal('fetch', fetchMock)

    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    const result = await updateHubspotContactById('fake-access-token', 'hs-contact-1', { email: 'ana@example.test', firstname: 'Ana' })

    expect(result).toEqual({ outcome: 'updated', hubspotContactId: 'hs-contact-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/hs-contact-1')
    expect(init.method).toBe('PATCH')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-access-token')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ properties: { email: 'ana@example.test', firstname: 'Ana' } })
    // Never a search/upsert-by-email body shape (no `inputs`/`idProperty`).
    expect(body).not.toHaveProperty('inputs')
    expect(body).not.toHaveProperty('idProperty')
  })

  it('URL-encodes the contact id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: '123' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await updateHubspotContactById('fake-access-token', 'weird id/with slash', { email: 'a@example.test' })
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/weird%20id%2Fwith%20slash')
  })

  it('returns { outcome: "not_found" } on a plain 404 — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ status: 'error', category: 'OBJECT_NOT_FOUND' }) }))
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await expect(updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })).resolves.toEqual({ outcome: 'not_found' })
  })

  it('returns { outcome: "not_found" } on a non-404 status whose body category is OBJECT_NOT_FOUND (defensive layering)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ status: 'error', category: 'OBJECT_NOT_FOUND' }) }))
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await expect(updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })).resolves.toEqual({ outcome: 'not_found' })
  })

  it('returns { outcome: "conflict", message } on a plain 409 — never throws, never leaks HubSpot\'s raw message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ status: 'error', category: 'CONFLICT', message: 'Contact already exists with email secret@example.test' }),
      }),
    )
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    const result = await updateHubspotContactById('fake-access-token', 'hs-1', { email: 'secret@example.test' })
    expect(result.outcome).toBe('conflict')
    expect(JSON.stringify(result)).not.toContain('secret@example.test')
  })

  it('returns { outcome: "conflict" } on a non-409 status whose body category is CONFLICT (defensive layering)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ status: 'error', category: 'CONFLICT' }) }))
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    const result = await updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })
    expect(result.outcome).toBe('conflict')
  })

  it('throws AppError (never returns not_found/conflict) for an unrecognized status/category — the safe default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ status: 'error', category: 'INTERNAL_ERROR' }) }))
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await expect(updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })).rejects.toThrow(/rechazó la actualización/i)
  })

  it('throws AppError for a 400 with no recognizable category at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ status: 'error' }) }))
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await expect(updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })).rejects.toThrow(/rechazó la actualización/i)
  })

  it('times out (AppError 504) when the request hangs, without logging the access token', async () => {
    const loggerErrorSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: loggerErrorSpy } }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        const abortError = new Error('The operation was aborted')
        abortError.name = 'AbortError'
        throw abortError
      }),
    )

    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await expect(updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })).rejects.toThrow(/tiempo de espera/i)

    const loggedText = JSON.stringify(loggerErrorSpy.mock.calls)
    expect(loggedText).not.toContain('fake-access-token')
  })

  it('throws AppError on a plain network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await expect(updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })).rejects.toThrow(/no se pudo contactar/i)
  })

  it('throws AppError when the success response has no usable id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await expect(updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })).rejects.toThrow(/identificador de contacto válido/i)
  })

  it('throws AppError when the response body is not valid JSON on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('not json') } }))
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await expect(updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })).rejects.toThrow(/respuesta inesperada/i)
  })

  it('never logs the response body on an error status — only status and category', async () => {
    const loggerSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerSpy, error: loggerSpy } }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ status: 'error', category: 'OBJECT_NOT_FOUND', message: 'No contact with id secret@example.test' }),
      }),
    )
    const { updateHubspotContactById } = await import('../src/services/hubspot-contacts.js')
    await updateHubspotContactById('fake-access-token', 'hs-1', { email: 'a@example.test' })

    const loggedText = JSON.stringify(loggerSpy.mock.calls)
    expect(loggedText).not.toContain('secret@example.test')
  })
})
