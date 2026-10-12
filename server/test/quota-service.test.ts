import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  QuotaMode,
  QuotaRepository,
  QuotaRpcResult,
  ReserveInput,
  ReserveResult,
  SettleInput,
  SettleResult,
} from '../src/repositories/quota-repository.js'
import {
  ESTIMATION_MESSAGE_OVERHEAD_TOKENS,
  ESTIMATION_REQUEST_OVERHEAD_TOKENS,
  QUOTA_TEMPORARY_ERROR_MESSAGE,
  QUOTA_UNAVAILABLE_MESSAGE,
  buildSettlementUsage,
  computeCostMicros,
  createQuotaService,
  evaluateNewConversation,
  estimateChatMessageUsage,
  hasUnpricedCacheTokens,
  newQuotaRequestId,
} from '../src/services/quota-service.js'

// quota-service.ts is tested against an injected repository (no Supabase,
// no network). The "fake database" below reproduces the Fase 1 SQL
// contract closely enough to exercise the service under concurrency:
// per-organization serialization, idempotency by request id, and
// decide-before-write denials. The real atomicity guarantee lives in
// Postgres and was verified separately (supabase/tests-usage-quotas.sql);
// these tests prove the SERVICE never weakens it (no client-side caching of
// allowances, no request-id reuse across messages, no cross-org effects).

const ORG_A = randomUUID()
const ORG_B = randomUUID()
const SESSION = randomUUID()

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const ESTIMATE = {
  estimatedInputTokens: 10,
  maxOutputTokens: 10,
  calls: { reply: { inputTokens: 4, outputTokens: 6 }, extraction: { inputTokens: 6, outputTokens: 4 } },
}

function reserveInput(overrides: Partial<{ requestId: string; organizationId: string; sessionId: string }> = {}) {
  return {
    requestId: overrides.requestId ?? newQuotaRequestId(),
    organizationId: overrides.organizationId ?? ORG_A,
    sessionId: overrides.sessionId ?? SESSION,
    model: 'test-model',
    estimate: ESTIMATE,
  }
}

function ok<T>(data: T): QuotaRpcResult<T> {
  return { ok: true, data }
}

function allowed(mode: QuotaMode, reservationId: string | null = mode === 'enforce' || mode === 'shadow' ? randomUUID() : null, reason: ReserveResult['reason'] = null): ReserveResult {
  return { allowed: true, mode, reservationId, reason, replayed: false }
}

function stubRepository(
  reserveImpl: (input: ReserveInput) => Promise<QuotaRpcResult<ReserveResult>>,
  settleImpl: (input: SettleInput) => Promise<QuotaRpcResult<SettleResult>> = async (input) =>
    ok({ reservationId: input.reservationId, actualMicros: 0, basis: 'actual', replayed: false }),
) {
  return {
    reserve: vi.fn(reserveImpl),
    settle: vi.fn(settleImpl),
    getStatus: vi.fn(),
    expireStale: vi.fn(),
    hasModelPrice: vi.fn(),
  } satisfies QuotaRepository
}

// ── estimation ────────────────────────────────────────────────────────────

describe('estimateChatMessageUsage', () => {
  const base = {
    replySystemPrompt: 'sistema',
    replyMessageContents: ['hola'],
    extractionSystemPrompt: 'extracción',
    extractionUserContentWithoutReply: 'Visitante: hola',
    maxReplyTokens: 1024,
    maxExtractionTokens: 800,
  }

  it('bounds output exactly by the sum of both calls max_tokens', () => {
    expect(estimateChatMessageUsage(base).maxOutputTokens).toBe(1824)
  })

  it('bounds input by the UTF-8 bytes of the exact strings sent, plus framing allowances', () => {
    const estimate = estimateChatMessageUsage(base)
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
    const expected =
      ESTIMATION_REQUEST_OVERHEAD_TOKENS + bytes('sistema') + bytes('hola') + ESTIMATION_MESSAGE_OVERHEAD_TOKENS +
      ESTIMATION_REQUEST_OVERHEAD_TOKENS + bytes('extracción') + bytes('Visitante: hola') + 1024 + 2 * ESTIMATION_MESSAGE_OVERHEAD_TOKENS
    expect(estimate.estimatedInputTokens).toBe(expected)
    expect(estimate.calls.reply.inputTokens + estimate.calls.extraction.inputTokens).toBe(expected)
    expect(estimate.calls.reply.outputTokens).toBe(1024)
    expect(estimate.calls.extraction.outputTokens).toBe(800)
  })

  it('counts multi-byte text (accents, emoji) by bytes, so it can never undercount', () => {
    const ascii = estimateChatMessageUsage({ ...base, replyMessageContents: ['aaaa'], extractionUserContentWithoutReply: 'aaaa' })
    const multibyte = estimateChatMessageUsage({ ...base, replyMessageContents: ['ñññ😀'], extractionUserContentWithoutReply: 'ñññ😀' })
    // 'ñññ😀' is 4 characters but 10 UTF-8 bytes, counted in both calls.
    expect(multibyte.estimatedInputTokens - ascii.estimatedInputTokens).toBe((10 - 4) * 2)
  })

  it('grows with the conversation (each new turn adds to both calls)', () => {
    const short = estimateChatMessageUsage(base)
    const longer = estimateChatMessageUsage({
      ...base,
      replyMessageContents: ['hola', 'respuesta', 'otra pregunta'],
      extractionUserContentWithoutReply: 'Visitante: hola\nAsistente: respuesta\nVisitante: otra pregunta',
    })
    expect(longer.estimatedInputTokens).toBeGreaterThan(short.estimatedInputTokens)
  })

  it('rejects invalid max_tokens values instead of producing a meaningless bound', () => {
    expect(() => estimateChatMessageUsage({ ...base, maxReplyTokens: -1 })).toThrow(RangeError)
    expect(() => estimateChatMessageUsage({ ...base, maxExtractionTokens: 1.5 })).toThrow(RangeError)
  })
})

// ── cost ──────────────────────────────────────────────────────────────────

describe('computeCostMicros (mirror of SQL quota_cost_micros)', () => {
  // Test prices only — 1 and 2 micro-USD per token. Not real Anthropic rates.
  const price = { inputMicrosPerMTok: 1_000_000n, outputMicrosPerMTok: 2_000_000n }

  it('matches the values asserted by supabase/tests-usage-quotas.sql', () => {
    expect(computeCostMicros(10, 10, price)).toBe(30n)
    expect(computeCostMicros(5, 5, price)).toBe(15n)
    expect(computeCostMicros(40, 10, price)).toBe(60n)
  })

  it('rounds up any fraction of a micro-USD', () => {
    expect(computeCostMicros(1, 0, { inputMicrosPerMTok: 1n, outputMicrosPerMTok: 0n })).toBe(1n)
    expect(computeCostMicros(0, 0, price)).toBe(0n)
  })

  it('stays exact beyond Number.MAX_SAFE_INTEGER intermediate values', () => {
    const big = { inputMicrosPerMTok: 9_007_199_254_740_993n, outputMicrosPerMTok: 0n }
    expect(computeCostMicros(1_000_000, 0, big)).toBe(9_007_199_254_740_993n)
  })

  it('rejects negative inputs', () => {
    expect(() => computeCostMicros(-1, 0, price)).toThrow(RangeError)
    expect(() => computeCostMicros(0, 0, { inputMicrosPerMTok: -1n, outputMicrosPerMTok: 0n })).toThrow(RangeError)
  })
})

describe('buildSettlementUsage (per-call settlement)', () => {
  // Bounds: reply 1000 in / 1024 out, extraction 1500 in / 800 out.
  const estimate = {
    estimatedInputTokens: 2500,
    maxOutputTokens: 1824,
    calls: { reply: { inputTokens: 1000, outputTokens: 1024 }, extraction: { inputTokens: 1500, outputTokens: 800 } },
  }
  const done = (inputTokens: number, outputTokens: number, model = 'm') => ({ status: 'completed' as const, usage: { inputTokens, outputTokens, model } })

  it('both calls completed → exact real usage', () => {
    expect(buildSettlementUsage(estimate, { reply: done(100, 20), extraction: done(150, 40) })).toEqual({ inputTokens: 250, outputTokens: 60, model: 'm' })
  })

  it('reply rejected (confirmed unbilled) before starting, extraction never made → zero', () => {
    expect(buildSettlementUsage(estimate, { reply: { status: 'rejected_unbilled' } })).toEqual({ inputTokens: 0, outputTokens: 0, model: null })
  })

  it('reply failed with unknown cost, extraction never made → ONLY the reply bound (the extraction certainly cost nothing)', () => {
    expect(buildSettlementUsage(estimate, { reply: { status: 'unknown' } })).toEqual({ inputTokens: 1000, outputTokens: 1024, model: null })
  })

  it('reply completed, extraction failed with unknown cost → reply real usage + extraction bound (never all-zero, never the whole estimate)', () => {
    expect(buildSettlementUsage(estimate, { reply: done(100, 20), extraction: { status: 'unknown' } })).toEqual({ inputTokens: 1600, outputTokens: 820, model: 'm' })
  })

  it('reply completed, extraction rejected (confirmed unbilled) → reply real usage only', () => {
    expect(buildSettlementUsage(estimate, { reply: done(100, 20), extraction: { status: 'rejected_unbilled' } })).toEqual({ inputTokens: 100, outputTokens: 20, model: 'm' })
  })

  it('reply completed, extraction skipped → reply real usage only', () => {
    expect(buildSettlementUsage(estimate, { reply: done(100, 20) })).toEqual({ inputTokens: 100, outputTokens: 20, model: 'm' })
  })

  it('no reply outcome at all → null (keep the whole reservation estimate)', () => {
    expect(buildSettlementUsage(estimate, {})).toBeNull()
  })

  it('completed calls reporting different models → null (cannot be priced as one)', () => {
    expect(buildSettlementUsage(estimate, { reply: done(1, 1, 'a'), extraction: done(1, 1, 'b') })).toBeNull()
  })

  it('a completed call WITH prompt-cache tokens is settled at its own bound (never its undercounted real input)', () => {
    const cached = { status: 'completed' as const, usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 900, model: 'm' } }
    expect(buildSettlementUsage(estimate, { reply: cached, extraction: done(5, 1) })).toEqual({
      inputTokens: estimate.calls.reply.inputTokens + 5,
      outputTokens: estimate.calls.reply.outputTokens + 1,
      model: 'm',
    })
    const created = { status: 'completed' as const, usage: { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 1, model: 'm' } }
    expect(buildSettlementUsage(estimate, { reply: created })).toEqual({
      inputTokens: estimate.calls.reply.inputTokens,
      outputTokens: estimate.calls.reply.outputTokens,
      model: null,
    })
  })

  it('zero (or absent) cache tokens keep the exact real usage, as before', () => {
    const zero = { status: 'completed' as const, usage: { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: 'm' } }
    expect(buildSettlementUsage(estimate, { reply: zero })).toEqual({ inputTokens: 10, outputTokens: 2, model: 'm' })
    expect(hasUnpricedCacheTokens({ inputTokens: 1, outputTokens: 1, model: 'm' })).toBe(false)
    expect(hasUnpricedCacheTokens({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, model: 'm' })).toBe(true)
  })

  it('a settlement never exceeds the reservation when every completed call stays within its bound', () => {
    const usage = buildSettlementUsage(estimate, { reply: done(1000, 1024), extraction: { status: 'unknown' } })!
    expect(usage.inputTokens).toBeLessThanOrEqual(estimate.estimatedInputTokens)
    expect(usage.outputTokens).toBeLessThanOrEqual(estimate.maxOutputTokens)
  })
})

// ── reserve: database answers ─────────────────────────────────────────────

describe('reserveForMessage — database answered', () => {
  it('proceeds with the reservation id under enforce', async () => {
    const reservationId = randomUUID()
    const repository = stubRepository(async () => ok(allowed('enforce', reservationId)))
    const service = createQuotaService({ repository, logger: silentLogger() })

    const decision = await service.reserveForMessage(reserveInput())

    expect(decision).toEqual({ proceed: true, mode: 'enforce', reservationId })
  })

  it('blocks under an enforce denial with ONLY the generic public message', async () => {
    const repository = stubRepository(async () =>
      ok({ allowed: false, mode: 'enforce', reservationId: null, reason: 'budget_exhausted', replayed: false }),
    )
    const service = createQuotaService({ repository, logger: silentLogger() })

    const decision = await service.reserveForMessage(reserveInput())

    expect(decision).toEqual({ proceed: false, reason: 'budget_exhausted', publicMessage: QUOTA_UNAVAILABLE_MESSAGE })
  })

  it.each([QUOTA_UNAVAILABLE_MESSAGE, QUOTA_TEMPORARY_ERROR_MESSAGE])(
    'public message %j never leaks plans, limits, amounts, costs, tokens or infrastructure',
    (message) => {
      expect(message).not.toMatch(/\d|cuota|plan|límite|limite|presupuesto|budget|token|costo|coste|\$|supabase|anthropic|error/i)
    },
  )

  it('proceeds without a reservation when the organization is EXPLICITLY off', async () => {
    const repository = stubRepository(async () => ok(allowed('off', null)))
    const service = createQuotaService({ repository, logger: silentLogger() })

    const decision = await service.reserveForMessage(reserveInput())

    expect(decision).toEqual({ proceed: true, mode: 'off', reservationId: null })
  })

  it('an organization with NO quota row is refused (current SQL: allowed=false)', async () => {
    const repository = stubRepository(async () =>
      ok({ allowed: false, mode: 'unconfigured', reservationId: null, reason: 'quota_not_configured', replayed: false }),
    )
    const service = createQuotaService({ repository, logger: silentLogger() })

    const decision = await service.reserveForMessage(reserveInput())

    expect(decision).toEqual({ proceed: false, reason: 'quota_not_configured', publicMessage: QUOTA_UNAVAILABLE_MESSAGE })
  })

  it('an organization with NO quota row is refused even if an older SQL version answers allowed=true', async () => {
    const logger = silentLogger()
    const repository = stubRepository(async () => ok(allowed('unconfigured', null)))
    const service = createQuotaService({ repository, logger })

    const decision = await service.reserveForMessage(reserveInput())

    expect(decision).toEqual({ proceed: false, reason: 'quota_not_configured', publicMessage: QUOTA_UNAVAILABLE_MESSAGE })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('shadow never blocks, even when enforce would have, and logs the would-deny reason', async () => {
    const logger = silentLogger()
    const reservationId = randomUUID()
    const repository = stubRepository(async () => ok(allowed('shadow', reservationId, 'budget_exhausted')))
    const service = createQuotaService({ repository, logger })

    const decision = await service.reserveForMessage(reserveInput())

    expect(decision).toEqual({ proceed: true, mode: 'shadow', reservationId })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('shadow'), expect.objectContaining({ reason: 'budget_exhausted' }))
  })

  it("shadow + 'model_price_missing' (nothing recorded) is a WARNING, not just info", async () => {
    const logger = silentLogger()
    const repository = stubRepository(async () => ok(allowed('shadow', null, 'model_price_missing')))
    const service = createQuotaService({ repository, logger })

    const decision = await service.reserveForMessage(reserveInput())

    expect(decision).toEqual({ proceed: true, mode: 'shadow', reservationId: null })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('shadow'), expect.objectContaining({ reason: 'model_price_missing' }))
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('sends exactly the given request id, organization, session, model and estimate', async () => {
    const repository = stubRepository(async () => ok(allowed('off', null)))
    const service = createQuotaService({ repository, logger: silentLogger() })
    const input = reserveInput()

    await service.reserveForMessage(input)

    expect(repository.reserve).toHaveBeenCalledWith({
      requestId: input.requestId,
      organizationId: ORG_A,
      sessionId: SESSION,
      model: 'test-model',
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
    })
  })
})

// ── reserve: database failures ────────────────────────────────────────────

describe('reserveForMessage — database failures', () => {
  it('retries a transient failure exactly once with the SAME request id', async () => {
    const reservationId = randomUUID()
    const repository = stubRepository(
      vi
        .fn<(input: ReserveInput) => Promise<QuotaRpcResult<ReserveResult>>>()
        .mockResolvedValueOnce({ ok: false, kind: 'transient', message: 'timeout' })
        .mockResolvedValueOnce(ok({ ...allowed('enforce', reservationId), replayed: true })),
    )
    const service = createQuotaService({ repository, logger: silentLogger() })
    const input = reserveInput()

    const decision = await service.reserveForMessage(input)

    expect(repository.reserve).toHaveBeenCalledTimes(2)
    expect(repository.reserve.mock.calls[0][0].requestId).toBe(input.requestId)
    expect(repository.reserve.mock.calls[1][0].requestId).toBe(input.requestId)
    expect(decision).toEqual({ proceed: true, mode: 'enforce', reservationId })
  })

  it.each(['rejected', 'invalid_response', 'not_configured'] as const)('does not retry a %s failure', async (kind) => {
    const repository = stubRepository(async () => ({ ok: false, kind, message: 'x' }))
    const service = createQuotaService({ repository, logger: silentLogger() })

    await service.reserveForMessage(reserveInput())

    expect(repository.reserve).toHaveBeenCalledTimes(1)
  })

  it.each(['transient', 'rejected', 'invalid_response', 'not_configured'] as const)(
    'FAILS CLOSED on any %s failure — no mode, no memory, no exception',
    async (kind) => {
      const logger = silentLogger()
      const repository = stubRepository(async () => ({ ok: false, kind, message: 'x' }))
      const service = createQuotaService({ repository, logger })

      const decision = await service.reserveForMessage(reserveInput())

      expect(decision).toEqual({ proceed: false, reason: 'verification_failed', publicMessage: QUOTA_TEMPORARY_ERROR_MESSAGE })
      expect(logger.error).toHaveBeenCalled()
    },
  )

  it('a previous successful "off" answer never relaxes a later failure (no remembered state)', async () => {
    const repository = stubRepository(
      vi
        .fn<(input: ReserveInput) => Promise<QuotaRpcResult<ReserveResult>>>()
        .mockResolvedValueOnce(ok(allowed('off', null)))
        .mockResolvedValue({ ok: false, kind: 'transient', message: 'down' }),
    )
    const service = createQuotaService({ repository, logger: silentLogger() })

    expect(await service.reserveForMessage(reserveInput())).toMatchObject({ proceed: true, mode: 'off' })
    expect(await service.reserveForMessage(reserveInput())).toMatchObject({ proceed: false, reason: 'verification_failed' })
  })

  it('surfaces an unexpected repository exception instead of treating it as allowed', async () => {
    // The repository contract is "never throws". If that contract is ever
    // broken, the error must surface (the chat's existing catch turns it
    // into a generic retryable SSE error) rather than be treated as "allowed".
    const repository = stubRepository(async () => {
      throw new Error('contract broken')
    })
    const service = createQuotaService({ repository, logger: silentLogger() })

    await expect(service.reserveForMessage(reserveInput())).rejects.toThrow('contract broken')
  })
})

// ── settle ────────────────────────────────────────────────────────────────

describe('settle', () => {
  it('does nothing without a reservation (off/unconfigured)', async () => {
    const repository = stubRepository(async () => ok(allowed('off', null)))
    const service = createQuotaService({ repository, logger: silentLogger() })

    await expect(service.settle(null, { inputTokens: 1, outputTokens: 1, model: 'm' })).resolves.toEqual({ settled: false })
    expect(repository.settle).not.toHaveBeenCalled()
  })

  it('passes real usage, or nulls when usage is unknown', async () => {
    const repository = stubRepository(async () => ok(allowed('off', null)))
    const service = createQuotaService({ repository, logger: silentLogger() })
    const reservationId = randomUUID()

    await service.settle(reservationId, { inputTokens: 7, outputTokens: 3, model: 'm' })
    await service.settle(reservationId, null)

    expect(repository.settle.mock.calls[0][0]).toEqual({ reservationId, inputTokens: 7, outputTokens: 3, model: 'm' })
    expect(repository.settle.mock.calls[1][0]).toEqual({ reservationId, inputTokens: null, outputTokens: null, model: null })
  })

  it('a LATE settlement of an already-expired reservation counts as settled, changes nothing, and is logged', async () => {
    const logger = silentLogger()
    const reservationId = randomUUID()
    const repository = stubRepository(
      async () => ok(allowed('off', null)),
      async () => ok({ reservationId, actualMicros: 900, basis: 'expired', replayed: true }),
    )
    const service = createQuotaService({ repository, logger })

    await expect(service.settle(reservationId, { inputTokens: 7, outputTokens: 3, model: 'm' })).resolves.toEqual({ settled: true })
    expect(repository.settle).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('expired'), { reservationId })
  })

  it('a normal settlement does not log the late-settlement warning', async () => {
    const logger = silentLogger()
    const service = createQuotaService({ repository: stubRepository(async () => ok(allowed('off', null))), logger })

    await service.settle(randomUUID(), { inputTokens: 1, outputTokens: 1, model: 'm' })

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('retries a transient failure once with the same reservation id and never throws', async () => {
    const logger = silentLogger()
    const repository = stubRepository(
      async () => ok(allowed('off', null)),
      async () => ({ ok: false, kind: 'transient', message: 'timeout' }),
    )
    const service = createQuotaService({ repository, logger })
    const reservationId = randomUUID()

    await expect(service.settle(reservationId, null)).resolves.toEqual({ settled: false })
    expect(repository.settle).toHaveBeenCalledTimes(2)
    expect(repository.settle.mock.calls.every(([input]) => input.reservationId === reservationId)).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('estimate'), expect.objectContaining({ reservationId }))
  })
})

// ── new-conversation pre-check ────────────────────────────────────────────

function statusFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mode: 'enforce' as const,
    status: 'active' as const,
    plan_code: 'pilot',
    period_start: '2026-10-01',
    conversation_limit: 10,
    budget_micros: 1_000,
    hourly_message_cap: null,
    conversations_used: 0,
    messages_used: 0,
    reserved_micros: 0,
    settled_micros: 0,
    ...overrides,
  } as Parameters<typeof evaluateNewConversation>[0]
}

describe('evaluateNewConversation', () => {
  it('allows an organization with quota available', () => {
    expect(evaluateNewConversation(statusFor({ conversations_used: 9, settled_micros: 500, reserved_micros: 499 }))).toBeNull()
  })

  it.each([
    ['suspended', { status: 'suspended' }],
    ['limit_not_configured', { conversation_limit: null }],
    ['limit_not_configured', { budget_micros: null }],
    ['conversation_limit_reached', { conversations_used: 10 }],
    ['budget_exhausted', { settled_micros: 1_000 }],
    ['budget_exhausted', { settled_micros: 600, reserved_micros: 400 }],
  ])('refuses with %s for %j', (reason, overrides) => {
    expect(evaluateNewConversation(statusFor(overrides))).toBe(reason)
  })

  it('checks suspension first, like the SQL reserve function', () => {
    expect(evaluateNewConversation(statusFor({ status: 'suspended', conversations_used: 10 }))).toBe('suspended')
  })

  it('refuses when the configured model has no price; ignores the field when it was not requested', () => {
    expect(evaluateNewConversation(statusFor({ model_price_configured: false }))).toBe('model_price_missing')
    expect(evaluateNewConversation(statusFor({ model_price_configured: true }))).toBeNull()
    expect(evaluateNewConversation(statusFor())).toBeNull() // no model asked → unchanged behavior
  })

  it('checks the missing price right after the mode, like reserve_chat_usage()', () => {
    expect(evaluateNewConversation(statusFor({ model_price_configured: false, status: 'suspended' }))).toBe('model_price_missing')
  })

  it('refuses an organization with no quota row (never unlimited)', () => {
    expect(evaluateNewConversation({ mode: 'unconfigured', period_start: '2026-10-01' })).toBe('quota_not_configured')
  })
})

describe('checkNewConversation', () => {
  function withStatus(result: QuotaRpcResult<ReturnType<typeof statusFor>> | QuotaRpcResult<{ mode: 'unconfigured'; period_start: string }>) {
    const repository = stubRepository(async () => ok(allowed('off', null)))
    repository.getStatus.mockResolvedValue(result)
    return repository
  }

  it('allows when quota is available, and never reserves or settles anything', async () => {
    const repository = withStatus(ok(statusFor()))
    const service = createQuotaService({ repository, logger: silentLogger(), model: () => 'configured-model' })

    await expect(service.checkNewConversation(ORG_A)).resolves.toMatchObject({ proceed: true, mode: 'enforce' })
    // Always asked WITH the configured model, so a missing price is caught here.
    expect(repository.getStatus).toHaveBeenCalledWith(ORG_A, 'configured-model')
    expect(repository.reserve).not.toHaveBeenCalled()
    expect(repository.settle).not.toHaveBeenCalled()
  })

  it.each([
    ['budget_exhausted', { settled_micros: 1_000 }],
    ['suspended', { status: 'suspended' }],
    ['conversation_limit_reached', { conversations_used: 10 }],
  ])('refuses under enforce (%s) with only the generic message', async (reason, overrides) => {
    const service = createQuotaService({ repository: withStatus(ok(statusFor(overrides))), logger: silentLogger() })

    await expect(service.checkNewConversation(ORG_A)).resolves.toEqual({
      proceed: false,
      reason,
      publicMessage: QUOTA_UNAVAILABLE_MESSAGE,
    })
  })

  it.each(['shadow', 'off'] as const)('never refuses under %s, even when exhausted', async (mode) => {
    const logger = silentLogger()
    const service = createQuotaService({ repository: withStatus(ok(statusFor({ mode, status: 'suspended' }))), logger })

    await expect(service.checkNewConversation(ORG_A)).resolves.toMatchObject({ proceed: true, mode })
  })

  it('ENFORCE + no price for the configured model → refused with only the generic message', async () => {
    const logger = silentLogger()
    const service = createQuotaService({ repository: withStatus(ok(statusFor({ model_price_configured: false }))), logger })

    await expect(service.checkNewConversation(ORG_A)).resolves.toEqual({
      proceed: false,
      reason: 'model_price_missing',
      publicMessage: QUOTA_UNAVAILABLE_MESSAGE,
    })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('SHADOW + no price → allowed, but logged as a WARNING (shadow would silently record nothing)', async () => {
    const logger = silentLogger()
    const service = createQuotaService({
      repository: withStatus(ok(statusFor({ mode: 'shadow', model_price_configured: false }))),
      logger,
      model: () => 'configured-model',
    })

    await expect(service.checkNewConversation(ORG_A)).resolves.toMatchObject({ proceed: true, mode: 'shadow' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('shadow'),
      expect.objectContaining({ reason: 'model_price_missing', model: 'configured-model' }),
    )
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('OFF + no price → allowed exactly as before (prices are not used in off)', async () => {
    const logger = silentLogger()
    const service = createQuotaService({ repository: withStatus(ok(statusFor({ mode: 'off', model_price_configured: false }))), logger })

    await expect(service.checkNewConversation(ORG_A)).resolves.toMatchObject({ proceed: true, mode: 'off' })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('refuses a new conversation for an organization with no quota row, with only the generic message', async () => {
    const service = createQuotaService({
      repository: withStatus(ok({ mode: 'unconfigured' as const, period_start: '2026-10-01' })),
      logger: silentLogger(),
    })

    await expect(service.checkNewConversation(ORG_A)).resolves.toEqual({
      proceed: false,
      reason: 'quota_not_configured',
      publicMessage: QUOTA_UNAVAILABLE_MESSAGE,
    })
  })

  it('an EXPLICIT off organization with no limits configured still opens conversations', async () => {
    const service = createQuotaService({
      repository: withStatus(ok(statusFor({ mode: 'off', conversation_limit: null, budget_micros: null }))),
      logger: silentLogger(),
    })

    await expect(service.checkNewConversation(ORG_A)).resolves.toMatchObject({ proceed: true, mode: 'off' })
  })

  it('fails closed with the retryable message when the status cannot be read (after one retry)', async () => {
    const repository = withStatus({ ok: false, kind: 'transient', message: 'down' })
    const service = createQuotaService({ repository, logger: silentLogger() })

    await expect(service.checkNewConversation(ORG_A)).resolves.toEqual({
      proceed: false,
      reason: 'verification_failed',
      publicMessage: QUOTA_TEMPORARY_ERROR_MESSAGE,
    })
    expect(repository.getStatus).toHaveBeenCalledTimes(2)
  })
})

// ── simulated database: idempotency, concurrency, isolation ──────────────

interface FakeOrg {
  mode: QuotaMode
  budget: number
  settled: number
  reserved: number
  messages: number
}

/**
 * Minimal in-memory stand-in for the Fase 1 SQL functions: serializes calls
 * per organization (like SELECT ... FOR UPDATE), decides before writing, and
 * replays an existing request id. Cost = 1 per input token + 2 per output
 * token (test values only).
 */
function createFakeDatabase(orgs: Record<string, FakeOrg>) {
  const locks = new Map<string, Promise<unknown>>()
  const reservations = new Map<string, { requestId: string; organizationId: string; sessionId: string; estimated: number; settled: boolean }>()
  const byRequest = new Map<string, string>()

  function withOrgLock<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(organizationId) ?? Promise.resolve()
    const next = previous.then(work, work)
    locks.set(organizationId, next.catch(() => undefined))
    return next
  }

  const yieldToOthers = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3))

  const repository: QuotaRepository = {
    async reserve(input) {
      return withOrgLock(input.organizationId, async () => {
        await yieldToOthers()
        const existingId = byRequest.get(input.requestId)
        if (existingId) {
          const existing = reservations.get(existingId)!
          if (existing.organizationId !== input.organizationId) {
            return { ok: false, kind: 'rejected', message: 'QUOTA_REQUEST_ID_CONFLICT' }
          }
          return ok({ allowed: true, mode: orgs[input.organizationId].mode, reservationId: existingId, reason: null, replayed: true })
        }
        const org = orgs[input.organizationId]
        if (org.mode === 'off') return ok(allowed('off', null))
        const estimated = input.estimatedInputTokens + input.maxOutputTokens * 2
        await yieldToOthers()
        if (org.settled + org.reserved + estimated > org.budget && org.mode === 'enforce') {
          return ok({ allowed: false, mode: 'enforce', reservationId: null, reason: 'budget_exhausted', replayed: false })
        }
        const id = randomUUID()
        reservations.set(id, { requestId: input.requestId, organizationId: input.organizationId, sessionId: input.sessionId, estimated, settled: false })
        byRequest.set(input.requestId, id)
        org.reserved += estimated
        org.messages += 1
        return ok({ allowed: true, mode: org.mode, reservationId: id, reason: null, replayed: false })
      })
    },
    async settle(input) {
      const reservation = reservations.get(input.reservationId)
      if (!reservation) return { ok: false, kind: 'rejected', message: 'QUOTA_RESERVATION_NOT_FOUND' }
      return withOrgLock(reservation.organizationId, async () => {
        await yieldToOthers()
        if (reservation.settled) {
          return ok({ reservationId: input.reservationId, actualMicros: 0, basis: 'actual', replayed: true })
        }
        const org = orgs[reservation.organizationId]
        const actual = input.inputTokens === null ? reservation.estimated : input.inputTokens + (input.outputTokens ?? 0) * 2
        reservation.settled = true
        org.reserved -= reservation.estimated
        org.settled += actual
        return ok({ reservationId: input.reservationId, actualMicros: actual, basis: input.inputTokens === null ? 'estimated' : 'actual', replayed: false })
      })
    },
    async getStatus() {
      return { ok: false, kind: 'not_configured', message: 'unused in these tests' }
    },
  }

  return { repository, reservations }
}

describe('simulated database', () => {
  it('idempotency: re-sending one message (same request id) never creates a second reservation or charge', async () => {
    const orgs = { [ORG_A]: { mode: 'enforce' as const, budget: 1_000, settled: 0, reserved: 0, messages: 0 } }
    const { repository, reservations } = createFakeDatabase(orgs)
    const service = createQuotaService({ repository, logger: silentLogger() })
    const input = reserveInput()

    const [first, second, third] = await Promise.all([
      service.reserveForMessage(input),
      service.reserveForMessage(input),
      service.reserveForMessage(input),
    ])

    expect(reservations.size).toBe(1)
    expect(orgs[ORG_A].reserved).toBe(30)
    expect(orgs[ORG_A].messages).toBe(1)
    const ids = [first, second, third].map((decision) => (decision.proceed ? decision.reservationId : null))
    expect(new Set(ids).size).toBe(1)
  })

  it('idempotency: settling the same reservation twice charges once', async () => {
    const orgs = { [ORG_A]: { mode: 'enforce' as const, budget: 1_000, settled: 0, reserved: 0, messages: 0 } }
    const { repository } = createFakeDatabase(orgs)
    const service = createQuotaService({ repository, logger: silentLogger() })

    const decision = await service.reserveForMessage(reserveInput())
    const reservationId = decision.proceed ? decision.reservationId : null
    await Promise.all([
      service.settle(reservationId, { inputTokens: 5, outputTokens: 5, model: 'test-model' }),
      service.settle(reservationId, { inputTokens: 5, outputTokens: 5, model: 'test-model' }),
    ])

    expect(orgs[ORG_A]).toMatchObject({ reserved: 0, settled: 15 })
  })

  it('concurrency: 20 simultaneous messages with budget for 5 → exactly 5 proceed', async () => {
    const orgs = { [ORG_A]: { mode: 'enforce' as const, budget: 150, settled: 0, reserved: 0, messages: 0 } }
    const { repository } = createFakeDatabase(orgs)
    const service = createQuotaService({ repository, logger: silentLogger() })

    const decisions = await Promise.all(Array.from({ length: 20 }, () => service.reserveForMessage(reserveInput())))

    expect(decisions.filter((decision) => decision.proceed)).toHaveLength(5)
    expect(decisions.filter((decision) => !decision.proceed)).toHaveLength(15)
    expect(orgs[ORG_A]).toMatchObject({ reserved: 150, messages: 5 })
  })

  it('isolation: an exhausted organization never affects another one', async () => {
    const orgs = {
      [ORG_A]: { mode: 'enforce' as const, budget: 30, settled: 0, reserved: 0, messages: 0 },
      [ORG_B]: { mode: 'enforce' as const, budget: 300, settled: 0, reserved: 0, messages: 0 },
    }
    const { repository } = createFakeDatabase(orgs)
    const service = createQuotaService({ repository, logger: silentLogger() })

    const decisions = await Promise.all([
      ...Array.from({ length: 5 }, () => service.reserveForMessage(reserveInput({ organizationId: ORG_A }))),
      ...Array.from({ length: 10 }, () => service.reserveForMessage(reserveInput({ organizationId: ORG_B }))),
    ])

    const decisionsA = decisions.slice(0, 5)
    const decisionsB = decisions.slice(5)
    expect(decisionsA.filter((decision) => decision.proceed)).toHaveLength(1)
    expect(decisionsB.every((decision) => decision.proceed)).toBe(true)
    expect(orgs[ORG_A]).toMatchObject({ reserved: 30, messages: 1 })
    expect(orgs[ORG_B]).toMatchObject({ reserved: 300, messages: 10 })
  })

  it('an outage blocks every organization equally — no organization keeps consuming unverified', async () => {
    const repository: QuotaRepository = {
      reserve: async () => ({ ok: false, kind: 'transient', message: 'down' }),
      settle: async () => ({ ok: false, kind: 'transient', message: 'down' }),
      getStatus: async () => ({ ok: false, kind: 'transient', message: 'down' }),
    }
    const service = createQuotaService({ repository, logger: silentLogger() })

    const decisions = await Promise.all([
      service.reserveForMessage(reserveInput({ organizationId: ORG_A })),
      service.reserveForMessage(reserveInput({ organizationId: ORG_B })),
    ])

    expect(decisions.every((decision) => !decision.proceed)).toBe(true)
  })

  it('a request id reused for a different organization is refused, never charged to either', async () => {
    const orgs = {
      [ORG_A]: { mode: 'enforce' as const, budget: 1_000, settled: 0, reserved: 0, messages: 0 },
      [ORG_B]: { mode: 'enforce' as const, budget: 1_000, settled: 0, reserved: 0, messages: 0 },
    }
    const { repository } = createFakeDatabase(orgs)
    const service = createQuotaService({ repository, logger: silentLogger() })
    const requestId = newQuotaRequestId()

    await service.reserveForMessage(reserveInput({ requestId, organizationId: ORG_A }))
    const reused = await service.reserveForMessage(reserveInput({ requestId, organizationId: ORG_B }))

    expect(reused).toMatchObject({ proceed: false, reason: 'verification_failed' })
    expect(orgs[ORG_B]).toMatchObject({ reserved: 0, messages: 0 })
  })
})
