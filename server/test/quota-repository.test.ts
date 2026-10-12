import { afterEach, describe, expect, it, vi } from 'vitest'

// quota-repository.ts must NEVER throw: every failure mode comes back as a
// typed `{ ok: false, kind }` so quota-service.ts alone decides whether it
// blocks (enforce) or is only logged (shadow). The mocked `.rpc(...)` return
// value exposes a chainable `.abortSignal(...)` — the real
// @supabase/postgrest-js shape — exactly like usage-events-repository.test.ts.

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.doUnmock('../src/lib/supabase-client.js')
})

const RESERVATION_ID = '3f2b6c1e-8a4d-4c2e-9b1a-7d5e6f8a9b0c'
const REQUEST_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const ORG_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const SESSION_ID = '7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918'

function mockRpc(outcome: { data?: unknown; error?: { message: string; code?: string } | null } | Error) {
  const abortSignal =
    outcome instanceof Error ? vi.fn().mockRejectedValue(outcome) : vi.fn().mockResolvedValue({ data: null, error: null, ...outcome })
  const rpc = vi.fn().mockReturnValue({ abortSignal })
  vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { rpc } }))
  return { rpc, abortSignal }
}

async function loadRepository() {
  return (await import('../src/repositories/quota-repository.js')).quotaRepository
}

const RESERVE_INPUT = {
  requestId: REQUEST_ID,
  organizationId: ORG_ID,
  sessionId: SESSION_ID,
  model: 'test-model',
  estimatedInputTokens: 120,
  maxOutputTokens: 1824,
}

describe('quotaRepository.reserve', () => {
  it('calls reserve_chat_usage with snake_cased params and maps the result to camelCase', async () => {
    const { rpc } = mockRpc({
      data: { allowed: true, mode: 'enforce', reservation_id: RESERVATION_ID, reason: null, replayed: false },
    })
    const repo = await loadRepository()

    const result = await repo.reserve(RESERVE_INPUT)

    expect(rpc).toHaveBeenCalledWith('reserve_chat_usage', {
      p_request_id: REQUEST_ID,
      p_organization_id: ORG_ID,
      p_session_id: SESSION_ID,
      p_model: 'test-model',
      p_estimated_input_tokens: 120,
      p_max_output_tokens: 1824,
    })
    expect(result).toEqual({
      ok: true,
      data: { allowed: true, mode: 'enforce', reservationId: RESERVATION_ID, reason: null, replayed: false },
    })
  })

  it('applies a per-call timeout through the native AbortSignal.timeout()', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { abortSignal } = mockRpc({ data: { allowed: true, mode: 'off', reservation_id: null, reason: null, replayed: false } })
    const repo = await loadRepository()
    const { QUOTA_RPC_TIMEOUT_MS } = await import('../src/repositories/quota-repository.js')

    await repo.reserve(RESERVE_INPUT)

    expect(timeoutSpy).toHaveBeenCalledWith(QUOTA_RPC_TIMEOUT_MS)
    expect(abortSignal.mock.calls[0][0]).toBe(timeoutSpy.mock.results[0]?.value)
  })

  it('accepts an enforce denial carrying a reason', async () => {
    mockRpc({ data: { allowed: false, mode: 'enforce', reservation_id: null, reason: 'budget_exhausted', replayed: false } })
    const repo = await loadRepository()

    const result = await repo.reserve(RESERVE_INPUT)

    expect(result).toEqual({
      ok: true,
      data: { allowed: false, mode: 'enforce', reservationId: null, reason: 'budget_exhausted', replayed: false },
    })
  })

  it('accepts the no-quota-row denial (unconfigured + quota_not_configured)', async () => {
    mockRpc({ data: { allowed: false, mode: 'unconfigured', reservation_id: null, reason: 'quota_not_configured', replayed: false } })
    const repo = await loadRepository()

    const result = await repo.reserve(RESERVE_INPUT)

    expect(result).toEqual({
      ok: true,
      data: { allowed: false, mode: 'unconfigured', reservationId: null, reason: 'quota_not_configured', replayed: false },
    })
  })

  it.each(['off', 'shadow'] as const)('treats a %s DENIAL as an unexpected response (only enforce/unconfigured can deny)', async (mode) => {
    mockRpc({ data: { allowed: false, mode, reservation_id: null, reason: 'budget_exhausted', replayed: false } })
    const repo = await loadRepository()

    const result = await repo.reserve(RESERVE_INPUT)

    expect(result).toMatchObject({ ok: false, kind: 'invalid_response' })
  })

  it('classifies a Postgres lock_timeout (55P03) as transient, so it is retried once with the same request id', async () => {
    mockRpc({ error: { message: 'canceling statement due to lock timeout', code: '55P03' } })
    const repo = await loadRepository()

    await expect(repo.reserve(RESERVE_INPUT)).resolves.toMatchObject({ ok: false, kind: 'transient' })
  })

  it('returns not_configured (never throws) when Supabase is not configured', async () => {
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: null }))
    const repo = await loadRepository()

    await expect(repo.reserve(RESERVE_INPUT)).resolves.toMatchObject({ ok: false, kind: 'not_configured' })
  })

  it.each([
    ['a SQL guard (request id conflict)', { message: 'QUOTA_REQUEST_ID_CONFLICT', code: 'P0001' }, 'rejected'],
    ['a SQL guard identified only by message', { message: 'QUOTA_INVALID_ARGUMENT' }, 'rejected'],
    ['missing EXECUTE privilege', { message: 'permission denied for function reserve_chat_usage', code: '42501' }, 'rejected'],
    ['the migration not being applied', { message: 'function does not exist', code: '42883' }, 'rejected'],
    ['a malformed uuid', { message: 'invalid input syntax for type uuid', code: '22P02' }, 'rejected'],
    ['a PostgREST request error', { message: 'Could not find the function', code: 'PGRST202' }, 'rejected'],
    ['a gateway/network error without a Postgres code', { message: 'fetch failed' }, 'transient'],
  ])('classifies %s as %s', async (_label, error, kind) => {
    mockRpc({ error })
    const repo = await loadRepository()

    await expect(repo.reserve(RESERVE_INPUT)).resolves.toMatchObject({ ok: false, kind })
  })

  it('classifies a thrown abort/timeout as transient instead of throwing', async () => {
    mockRpc(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const repo = await loadRepository()

    await expect(repo.reserve(RESERVE_INPUT)).resolves.toMatchObject({ ok: false, kind: 'transient' })
  })

  it.each([
    ['null data', null],
    ['a missing field', { allowed: true, mode: 'enforce', reservation_id: RESERVATION_ID, reason: null }],
    ['an unknown mode', { allowed: true, mode: 'turbo', reservation_id: null, reason: null, replayed: false }],
    ['an unknown deny reason', { allowed: false, mode: 'enforce', reservation_id: null, reason: 'whatever', replayed: false }],
    ['a non-uuid reservation id', { allowed: true, mode: 'enforce', reservation_id: 'abc', reason: null, replayed: false }],
    ['a denial outside enforce mode', { allowed: false, mode: 'shadow', reservation_id: null, reason: 'budget_exhausted', replayed: false }],
    ['a denial without a reason', { allowed: false, mode: 'enforce', reservation_id: null, reason: null, replayed: false }],
    ['an enforce allowance without a reservation', { allowed: true, mode: 'enforce', reservation_id: null, reason: null, replayed: false }],
  ])('rejects %s as invalid_response', async (_label, data) => {
    mockRpc({ data })
    const repo = await loadRepository()

    await expect(repo.reserve(RESERVE_INPUT)).resolves.toMatchObject({ ok: false, kind: 'invalid_response' })
  })
})

describe('quotaRepository.settle', () => {
  it('passes real usage through and maps the result', async () => {
    const { rpc } = mockRpc({ data: { reservation_id: RESERVATION_ID, actual_micros: 15, basis: 'actual', replayed: false } })
    const repo = await loadRepository()

    const result = await repo.settle({ reservationId: RESERVATION_ID, inputTokens: 5, outputTokens: 5, model: 'test-model' })

    expect(rpc).toHaveBeenCalledWith('settle_chat_usage', {
      p_reservation_id: RESERVATION_ID,
      p_input_tokens: 5,
      p_output_tokens: 5,
      p_model: 'test-model',
    })
    expect(result).toEqual({ ok: true, data: { reservationId: RESERVATION_ID, actualMicros: 15, basis: 'actual', replayed: false } })
  })

  it('passes nulls through for unknown usage (the database keeps the estimate)', async () => {
    const { rpc } = mockRpc({ data: { reservation_id: RESERVATION_ID, actual_micros: 60, basis: 'estimated', replayed: false } })
    const repo = await loadRepository()

    await repo.settle({ reservationId: RESERVATION_ID, inputTokens: null, outputTokens: null, model: null })

    expect(rpc.mock.calls[0][1]).toEqual({ p_reservation_id: RESERVATION_ID, p_input_tokens: null, p_output_tokens: null, p_model: null })
  })

  it('rejects a negative amount as invalid_response', async () => {
    mockRpc({ data: { reservation_id: RESERVATION_ID, actual_micros: -1, basis: 'actual', replayed: false } })
    const repo = await loadRepository()

    await expect(
      repo.settle({ reservationId: RESERVATION_ID, inputTokens: 1, outputTokens: 1, model: 'test-model' }),
    ).resolves.toMatchObject({ ok: false, kind: 'invalid_response' })
  })

  it("accepts a late replay of a reservation already closed as 'expired'", async () => {
    mockRpc({ data: { reservation_id: RESERVATION_ID, actual_micros: 900, basis: 'expired', replayed: true } })
    const repo = await loadRepository()

    await expect(
      repo.settle({ reservationId: RESERVATION_ID, inputTokens: 1, outputTokens: 1, model: 'test-model' }),
    ).resolves.toEqual({ ok: true, data: { reservationId: RESERVATION_ID, actualMicros: 900, basis: 'expired', replayed: true } })
  })
})

describe('quotaRepository.expireStale', () => {
  const SQL_RESULT = {
    expired_count: 3,
    expired_micros: 4_500,
    organizations_processed: 2,
    organizations_skipped_locked: 1,
    organizations_failed: 0,
  }

  it('calls expire_stale_chat_reservations with the 15-minute window and maps the result', async () => {
    const { rpc } = mockRpc({ data: SQL_RESULT })
    const repo = await loadRepository()

    const result = await repo.expireStale()

    expect(rpc).toHaveBeenCalledWith('expire_stale_chat_reservations', { p_older_than: '15 minutes' })
    expect(result).toEqual({
      ok: true,
      data: { expiredCount: 3, expiredMicros: 4_500, organizationsProcessed: 2, organizationsSkippedLocked: 1, organizationsFailed: 0 },
    })
  })

  it('uses its own, longer timeout (off the visitor critical path)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    mockRpc({ data: SQL_RESULT })
    const repo = await loadRepository()
    const { QUOTA_EXPIRE_RPC_TIMEOUT_MS, QUOTA_RPC_TIMEOUT_MS } = await import('../src/repositories/quota-repository.js')

    await repo.expireStale()

    expect(timeoutSpy).toHaveBeenCalledWith(QUOTA_EXPIRE_RPC_TIMEOUT_MS)
    expect(QUOTA_EXPIRE_RPC_TIMEOUT_MS).toBeGreaterThan(QUOTA_RPC_TIMEOUT_MS)
  })

  it('the expiry window never drops below the 15 minutes the SQL function enforces', async () => {
    const { RESERVATION_EXPIRY_MINUTES } = await import('../src/repositories/quota-repository.js')
    expect(RESERVATION_EXPIRY_MINUTES).toBeGreaterThanOrEqual(15)
  })

  it('rejects an unexpected shape (e.g. a negative count) as invalid_response', async () => {
    mockRpc({ data: { ...SQL_RESULT, expired_count: -1 } })
    const repo = await loadRepository()

    await expect(repo.expireStale()).resolves.toMatchObject({ ok: false, kind: 'invalid_response' })
  })

  it('never throws: a thrown timeout comes back as transient', async () => {
    mockRpc(new Error('The operation was aborted due to timeout'))
    const repo = await loadRepository()

    await expect(repo.expireStale()).resolves.toMatchObject({ ok: false, kind: 'transient' })
  })

  it('returns not_configured when Supabase is not configured', async () => {
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: null }))
    const repo = await loadRepository()

    await expect(repo.expireStale()).resolves.toMatchObject({ ok: false, kind: 'not_configured' })
  })
})

describe('quotaRepository.getStatus — model price', () => {
  it('without a model: the call is exactly as before (no p_model)', async () => {
    const { rpc } = mockRpc({ data: { mode: 'unconfigured', period_start: '2026-10-01' } })
    const repo = await loadRepository()

    await repo.getStatus(ORG_ID)

    expect(rpc).toHaveBeenCalledWith('get_organization_quota_status', { p_organization_id: ORG_ID })
  })

  it('with a model: passes p_model and parses model_price_configured', async () => {
    const { rpc } = mockRpc({
      data: {
        mode: 'enforce', status: 'active', plan_code: 'pilot', period_start: '2026-10-01',
        conversation_limit: 10, budget_micros: 1000, hourly_message_cap: null,
        conversations_used: 0, messages_used: 0, reserved_micros: 0, settled_micros: 0,
        model_price_configured: false,
      },
    })
    const repo = await loadRepository()

    const result = await repo.getStatus(ORG_ID, 'claude-test-model')

    expect(rpc).toHaveBeenCalledWith('get_organization_quota_status', { p_organization_id: ORG_ID, p_model: 'claude-test-model' })
    expect(result).toMatchObject({ ok: true, data: { mode: 'enforce', model_price_configured: false } })
  })
})

describe('quotaRepository.hasModelPrice', () => {
  function mockTable(outcome: { data?: unknown; error?: { message: string; code?: string } | null } | Error) {
    const maybeSingle =
      outcome instanceof Error ? vi.fn().mockRejectedValue(outcome) : vi.fn().mockResolvedValue({ data: null, error: null, ...outcome })
    const abortSignal = vi.fn().mockReturnValue({ maybeSingle })
    const eq = vi.fn().mockReturnValue({ abortSignal })
    const select = vi.fn().mockReturnValue({ eq })
    const from = vi.fn().mockReturnValue({ select })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
    return { from, select, eq, abortSignal }
  }

  it('reads model_prices by the exact identifier, with a timeout; a row → true', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { from, select, eq } = mockTable({ data: { model: 'claude-test-model' } })
    const repo = await loadRepository()

    await expect(repo.hasModelPrice('claude-test-model')).resolves.toEqual({ ok: true, data: true })
    expect(from).toHaveBeenCalledWith('model_prices')
    expect(select).toHaveBeenCalledWith('model') // never reads the price itself
    expect(eq).toHaveBeenCalledWith('model', 'claude-test-model')
    expect(timeoutSpy).toHaveBeenCalled()
  })

  it('no row → false', async () => {
    mockTable({ data: null })
    const repo = await loadRepository()

    await expect(repo.hasModelPrice('claude-test-model')).resolves.toEqual({ ok: true, data: false })
  })

  it('a query error (e.g. the migration not applied) is returned, never thrown', async () => {
    mockTable({ error: { message: 'relation "model_prices" does not exist', code: '42P01' } })
    const repo = await loadRepository()

    await expect(repo.hasModelPrice('claude-test-model')).resolves.toMatchObject({ ok: false })
  })

  it('a thrown timeout comes back as transient', async () => {
    mockTable(new Error('The operation was aborted due to timeout'))
    const repo = await loadRepository()

    await expect(repo.hasModelPrice('claude-test-model')).resolves.toMatchObject({ ok: false, kind: 'transient' })
  })

  it('Supabase not configured → not_configured', async () => {
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: null }))
    const repo = await loadRepository()

    await expect(repo.hasModelPrice('claude-test-model')).resolves.toMatchObject({ ok: false, kind: 'not_configured' })
  })
})

describe('quotaRepository.getStatus', () => {
  it('parses an unconfigured organization', async () => {
    mockRpc({ data: { mode: 'unconfigured', period_start: '2026-10-01' } })
    const repo = await loadRepository()

    await expect(repo.getStatus(ORG_ID)).resolves.toEqual({
      ok: true,
      data: { mode: 'unconfigured', period_start: '2026-10-01' },
    })
  })

  it('parses a configured organization with NULL limits', async () => {
    const { rpc } = mockRpc({
      data: {
        mode: 'off',
        status: 'active',
        plan_code: 'pilot',
        period_start: '2026-10-01',
        conversation_limit: null,
        budget_micros: null,
        hourly_message_cap: null,
        conversations_used: 0,
        messages_used: 0,
        reserved_micros: 0,
        settled_micros: 0,
      },
    })
    const repo = await loadRepository()

    const result = await repo.getStatus(ORG_ID)

    expect(rpc).toHaveBeenCalledWith('get_organization_quota_status', { p_organization_id: ORG_ID })
    expect(result.ok).toBe(true)
  })
})
