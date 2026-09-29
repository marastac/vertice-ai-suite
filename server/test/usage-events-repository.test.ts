import { afterEach, describe, expect, it, vi } from 'vitest'

// recordUsageEvent() is the ONLY writer of usage_events, and it is the
// enforcement point of the "metering can never break the chat" requirement
// — it must NEVER throw/reject, under any failure mode, including its own
// 5-second .abortSignal(AbortSignal.timeout(...)) timeout on the insert
// call (Fase B correction round 2, correction 1). Every scenario below
// asserts a resolved (never rejected) promise, mirroring exactly how
// chat-service.ts calls this function (awaited, but by contract never
// throws into that await).
//
// The mocked `insert(...)` return value below always exposes a chainable
// `.abortSignal(...)` method — matching the REAL @supabase/postgrest-js
// shape used in usage-events-repository.ts — so these mocks reflect the
// actual call shape, not a simplified stand-in for it.
//
// None of these tests wait a real 5 seconds: the timeout VALUE is verified
// by spying on the native AbortSignal.timeout() static method, and an
// actual abort/timeout OUTCOME is simulated by making the mocked
// `.abortSignal(...)` call itself reject/resolve as PostgREST would when a
// request is aborted — never by letting a real timer fire.

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../src/lib/supabase-client.js')
  vi.doUnmock('../src/lib/logger.js')
})

/** Builds a `supabaseAdmin` mock whose `.from().insert()` chain ends in `.abortSignal(...)` resolving to `result`. */
function mockSupabaseInsert(result: { error: { message: string } | null }) {
  const abortSignal = vi.fn().mockResolvedValue(result)
  const insert = vi.fn().mockReturnValue({ abortSignal })
  const from = vi.fn().mockReturnValue({ insert })
  vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
  return { from, insert, abortSignal }
}

const FIXTURE_INPUT = {
  organizationId: 'org-1',
  sessionId: 'session-1',
  purpose: 'reply' as const,
  model: 'claude-test-model',
  inputTokens: 10,
  outputTokens: 5,
}

describe('recordUsageEvent', () => {
  it('inserts exactly the given fields, snake_cased, when Supabase is configured', async () => {
    const { from, insert } = mockSupabaseInsert({ error: null })

    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')
    await recordUsageEvent(FIXTURE_INPUT)

    expect(from).toHaveBeenCalledWith('usage_events')
    expect(insert).toHaveBeenCalledWith({
      organization_id: 'org-1',
      session_id: 'session-1',
      purpose: 'reply',
      model: 'claude-test-model',
      input_tokens: 10,
      output_tokens: 5,
    })
  })

  it('applies the INSERT-only timeout via the native AbortSignal.timeout(5000) mechanism — no Promise.race, no new dependency', async () => {
    // Spying (not replacing) the real, native AbortSignal.timeout — this
    // proves the actual constant/mechanism used in
    // usage-events-repository.ts, not just a mock's own assumption about it.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { abortSignal } = mockSupabaseInsert({ error: null })

    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')
    await recordUsageEvent(FIXTURE_INPUT)

    expect(timeoutSpy).toHaveBeenCalledWith(5000)
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
    // Confirms the SAME signal AbortSignal.timeout(5000) produced is what
    // was actually chained onto the insert call, not a coincidentally-equal
    // separate one.
    expect(abortSignal.mock.calls[0][0]).toBe(timeoutSpy.mock.results[0]?.value)

    timeoutSpy.mockRestore()
  })

  it('a normal (fast) insert completes and resolves normally with the timeout configured — the timeout never gets in the way of the ordinary case', async () => {
    mockSupabaseInsert({ error: null })
    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')

    await expect(recordUsageEvent(FIXTURE_INPUT)).resolves.toBeUndefined()
  })

  it('captures an INSERT timeout/abort surfaced as a normal PostgREST `error` (the documented common case) WITHOUT throwing', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    mockSupabaseInsert({ error: { message: 'FetchError: The user aborted a request.' } })

    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')
    await expect(recordUsageEvent(FIXTURE_INPUT)).resolves.toBeUndefined()

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
  })

  it('captures an INSERT timeout/abort that instead REJECTS (the second-safety-net case) WITHOUT throwing', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    const abortError = new DOMException('This operation was aborted', 'AbortError')
    const abortSignal = vi.fn().mockRejectedValue(abortError)
    const insert = vi.fn().mockReturnValue({ abortSignal })
    const from = vi.fn().mockReturnValue({ insert })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))

    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')
    await expect(recordUsageEvent(FIXTURE_INPUT)).resolves.toBeUndefined()

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
    expect(loggerWarnSpy).toHaveBeenCalledWith('Failed to record usage event — chat continues normally', {
      purpose: 'reply',
      message: expect.stringContaining('aborted'),
    })
  })

  it('is a silent no-op (never throws) when Supabase is not configured at all', async () => {
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: null }))
    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')

    await expect(recordUsageEvent(FIXTURE_INPUT)).resolves.toBeUndefined()
  })

  it('never throws when the insert itself returns a Postgres error (unrelated to the timeout) — logs a warning instead', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    mockSupabaseInsert({ error: { message: 'insert failed' } })

    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')
    await expect(recordUsageEvent({ ...FIXTURE_INPUT, purpose: 'extraction' })).resolves.toBeUndefined()
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
  })

  it('never throws when the Supabase client itself throws synchronously', async () => {
    const from = vi.fn(() => {
      throw new Error('boom')
    })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))

    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')
    await expect(recordUsageEvent(FIXTURE_INPUT)).resolves.toBeUndefined()
  })

  it('never logs conversation content — only ids, purpose, model, and token counts ever reach it', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    mockSupabaseInsert({ error: { message: 'contains secret@example.test?? no — never passed in' } })

    const { recordUsageEvent } = await import('../src/repositories/usage-events-repository.js')
    await recordUsageEvent(FIXTURE_INPUT)

    // The function's own input type has no field for email/phone/message
    // content at all — this just confirms the warn call carries only the
    // purpose and the (already-sanitized-by-Postgres) error message.
    expect(loggerWarnSpy).toHaveBeenCalledWith('Failed to record usage event — chat continues normally', {
      purpose: 'reply',
      message: expect.any(String),
    })
  })
})
