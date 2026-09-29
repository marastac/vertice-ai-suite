import { afterEach, describe, expect, it, vi } from 'vitest'

// loadChatConfigurationForOrganization() is the backend's own server-side
// source of truth for a chat's real configuration — used to stop a
// resolved organization's chat prompt from ever being built out of a
// client-supplied config (see the config-trust hardening report). Three
// deliberately distinct states, same reasoning as organization-lookup.ts's
// four: a genuine Supabase query FAILURE must never be reported the same
// way as "no chat_configuration row exists for this organization" — callers
// treat the two very differently (a permanent 404 vs. a retryable 503).
//
// This query is also bounded by a 5-second .abortSignal(AbortSignal.timeout(...))
// timeout (same native mechanism/constant as usage-events-repository.ts's
// INSERT timeout) — the mocked `.maybeSingle()` return value below always
// exposes a chainable `.abortSignal(...)` method matching the REAL
// @supabase/postgrest-js shape the repository actually calls. None of these
// tests wait a real 5 seconds: the timeout VALUE is verified by spying on
// the native AbortSignal.timeout() static method, and an actual
// abort/timeout OUTCOME is simulated by making the mocked `.abortSignal(...)`
// call itself resolve as PostgREST would when a request is aborted — never
// by letting a real timer fire.

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../src/lib/supabase-client.js')
  vi.doUnmock('../src/lib/logger.js')
})

/**
 * Builds a `supabaseAdmin` mock whose `.from().select().eq()` chain ends in
 * `.abortSignal(...).maybeSingle()` resolving to `result` — matching the
 * REAL call order in chat-config-repository.ts (`.abortSignal()` must be
 * chained BEFORE `.maybeSingle()`; see that file's own comment on why).
 */
function mockSupabaseChatConfigQuery(result: { data: Record<string, unknown> | null; error: { message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const abortSignal = vi.fn().mockReturnValue({ maybeSingle })
  const eq = vi.fn().mockReturnValue({ abortSignal })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
  return { from, select, eq, maybeSingle, abortSignal }
}

const FIXTURE_ROW = {
  assistant_name: 'Sofía',
  welcome_message: 'Hola, ¿en qué puedo ayudarte?',
  agency_description: 'Agencia de marketing real',
  services_offered: 'SEO, Ads',
  tone: 'professional',
  language: 'Español',
  questions_to_collect: ['¿Cuál es tu presupuesto?'],
  criteria: [{ id: 'c1', label: 'Presupuesto', points: 40 }],
  min_qualified_score: 75,
  additional_instructions: 'Prioriza leads con presupuesto alto.',
  is_active: true,
}

describe('loadChatConfigurationForOrganization', () => {
  it('returns { status: "found", config } mapped from snake_case columns to the canonical ChatConfigurationInput shape', async () => {
    const { from, eq } = mockSupabaseChatConfigQuery({ data: FIXTURE_ROW, error: null })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    const result = await loadChatConfigurationForOrganization('org-real-uuid')

    expect(from).toHaveBeenCalledWith('chat_configuration')
    expect(eq).toHaveBeenCalledWith('organization_id', 'org-real-uuid')
    expect(result).toEqual({
      status: 'found',
      config: {
        assistantName: 'Sofía',
        welcomeMessage: 'Hola, ¿en qué puedo ayudarte?',
        agencyDescription: 'Agencia de marketing real',
        servicesOffered: 'SEO, Ads',
        tone: 'professional',
        language: 'Español',
        questionsToCollect: ['¿Cuál es tu presupuesto?'],
        criteria: [{ id: 'c1', label: 'Presupuesto', points: 40 }],
        minQualifiedScore: 75,
        additionalInstructions: 'Prioriza leads con presupuesto alto.',
        isActive: true,
      },
    })
  })

  it('maps a null additional_instructions column to undefined (matching chatConfigurationSchema\'s .optional())', async () => {
    mockSupabaseChatConfigQuery({ data: { ...FIXTURE_ROW, additional_instructions: null }, error: null })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    const result = await loadChatConfigurationForOrganization('org-real-uuid')

    expect(result.status).toBe('found')
    expect(result.status === 'found' && result.config.additionalInstructions).toBeUndefined()
  })

  it('returns { status: "not_found" } when the query succeeds but no chat_configuration row matches this organization_id', async () => {
    mockSupabaseChatConfigQuery({ data: null, error: null })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    await expect(loadChatConfigurationForOrganization('org-without-chat-config')).resolves.toEqual({ status: 'not_found' })
  })

  it('returns { status: "unavailable" } (never "not_found") when the query itself fails', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    mockSupabaseChatConfigQuery({ data: null, error: { message: 'connection error' } })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    await expect(loadChatConfigurationForOrganization('org-real-uuid')).resolves.toEqual({ status: 'unavailable' })
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
  })

  it('applies a 5000ms timeout via the native AbortSignal.timeout() mechanism — no Promise.race, no new dependency', async () => {
    // Spying (not replacing) the real, native AbortSignal.timeout — this
    // proves the actual constant/mechanism used in
    // chat-config-repository.ts, not just a mock's own assumption about it.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { abortSignal } = mockSupabaseChatConfigQuery({ data: FIXTURE_ROW, error: null })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    await loadChatConfigurationForOrganization('org-real-uuid')

    expect(timeoutSpy).toHaveBeenCalledWith(5000)
    // Confirms the SAME signal AbortSignal.timeout(5000) produced is what
    // was actually chained onto the query via .abortSignal(...), not a
    // coincidentally-equal separate one.
    expect(abortSignal).toHaveBeenCalledWith(timeoutSpy.mock.results[0]?.value)

    timeoutSpy.mockRestore()
  })

  it('a normal (fast) query completes and resolves "found" with the timeout configured — the timeout never gets in the way of the ordinary case', async () => {
    mockSupabaseChatConfigQuery({ data: FIXTURE_ROW, error: null })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    await expect(loadChatConfigurationForOrganization('org-real-uuid')).resolves.toMatchObject({ status: 'found' })
  })

  it('classifies a query timeout/abort (simulated — never a real 5s wait) as "unavailable", the SAME as any other query failure', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    // Simulates PostgREST's own documented behavior of surfacing an abort
    // as a normal `error` result rather than a thrown exception.
    mockSupabaseChatConfigQuery({ data: null, error: { message: 'FetchError: The user aborted a request.' } })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    const result = await loadChatConfigurationForOrganization('org-real-uuid')

    expect(result).toEqual({ status: 'unavailable' })
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
  })

  it('a timeout is NEVER confused with "not_found" — a timeout means "unknown", not "confirmed absent"', async () => {
    mockSupabaseChatConfigQuery({ data: null, error: { message: 'FetchError: The user aborted a request.' } })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    const result = await loadChatConfigurationForOrganization('org-real-uuid')

    expect(result.status).not.toBe('not_found')
    expect(result.status).toBe('unavailable')
  })

  it('classifies a query timeout/abort that instead REJECTS (the second-safety-net case) as "unavailable" without throwing', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    const abortError = new DOMException('This operation was aborted', 'AbortError')
    const maybeSingle = vi.fn().mockRejectedValue(abortError)
    const abortSignal = vi.fn().mockReturnValue({ maybeSingle })
    const eq = vi.fn().mockReturnValue({ abortSignal })
    const select = vi.fn().mockReturnValue({ eq })
    const from = vi.fn().mockReturnValue({ select })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))

    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')
    await expect(loadChatConfigurationForOrganization('org-real-uuid')).resolves.toEqual({ status: 'unavailable' })
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
  })

  it('returns { status: "unavailable" } and never throws when the client itself throws synchronously', async () => {
    const from = vi.fn(() => {
      throw new Error('boom')
    })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    await expect(loadChatConfigurationForOrganization('org-real-uuid')).resolves.toEqual({ status: 'unavailable' })
  })

  it('returns { status: "unavailable" } (defensive only) when supabaseAdmin is null — real call sites never reach this', async () => {
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: null }))
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    await expect(loadChatConfigurationForOrganization('org-real-uuid')).resolves.toEqual({ status: 'unavailable' })
  })

  it('never logs the organization id or any config content — only a sanitized error message', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    mockSupabaseChatConfigQuery({ data: null, error: { message: 'connection error' } })
    const { loadChatConfigurationForOrganization } = await import('../src/repositories/chat-config-repository.js')

    await loadChatConfigurationForOrganization('org-secret-uuid')

    const loggedText = JSON.stringify(loggerWarnSpy.mock.calls)
    expect(loggedText).not.toContain('org-secret-uuid')
  })
})
