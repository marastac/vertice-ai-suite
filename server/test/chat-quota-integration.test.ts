import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatConfigurationInput } from '../src/schemas/chat.js'
import type { ChatTurn } from '../src/services/ai-provider.js'
import type { OrganizationResolution } from '../src/services/organization-lookup.js'
import type { QuotaMode, QuotaRpcResult, ReserveResult, SettleResult } from '../src/repositories/quota-repository.js'

// Fase 3: chat-service.ts ⇄ quota-service.ts behind CHAT_QUOTAS_ENABLED.
//
// Every external dependency is mocked (sessions, Anthropic, usage_events,
// org lookup, chat_configuration). The quota layer is exercised through the
// REAL quota-service.ts — only quota-repository.ts (or, for the "migration
// not applied" cases, the Supabase client underneath the REAL repository) is
// replaced. So these tests prove the actual wiring: ordering, what is (and
// is never) called, and what gets settled.

const FLAG = 'CHAT_QUOTAS_ENABLED'
let savedFlag: string | undefined

beforeEach(() => {
  savedFlag = process.env[FLAG]
})

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = savedFlag
  vi.resetModules()
  vi.doUnmock('../src/repositories/session-repository.js')
  vi.doUnmock('../src/repositories/usage-events-repository.js')
  vi.doUnmock('../src/repositories/chat-config-repository.js')
  vi.doUnmock('../src/repositories/quota-repository.js')
  vi.doUnmock('../src/services/ai-provider.js')
  vi.doUnmock('../src/services/organization-lookup.js')
  vi.doUnmock('../src/lib/supabase-client.js')
})

const CONFIG: ChatConfigurationInput = {
  assistantName: 'Asistente',
  welcomeMessage: 'Hola',
  agencyDescription: 'Descripción',
  servicesOffered: 'Servicios',
  tone: 'professional',
  language: 'Español',
  questionsToCollect: ['¿Presupuesto?'],
  criteria: [{ id: 'c1', label: 'Criterio', points: 50 }],
  minQualifiedScore: 70,
  isActive: true,
}

const ORG_ID = randomUUID()
const RESOLVED: OrganizationResolution = { status: 'resolved', organizationId: ORG_ID }
const REPLY = { text: 'Hola mundo', usage: { inputTokens: 100, outputTokens: 20 }, model: 'm-1' }
const EXTRACTION = { text: '{}', usage: { inputTokens: 150, outputTokens: 40 }, model: 'm-1' }

interface Session {
  id: string
  orgSlug: string
  organization: OrganizationResolution
  config: ChatConfigurationInput
  configSource?: 'server' | 'local'
  createdAt: string
  updatedAt: string
  history: ChatTurn[]
  /** Only present on sessions persisted by the Fase 3 build (now ignored) — used to prove stale state is never trusted. */
  quotaMode?: QuotaMode
}

function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    orgSlug: 'acme',
    organization: RESOLVED,
    config: CONFIG,
    configSource: 'server',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    history: [],
    ...overrides,
  }
}

function handlers() {
  return { onDelta: vi.fn(), onQualification: vi.fn(), onLimitReached: vi.fn(), onQuotaBlocked: vi.fn() }
}

function ok<T>(data: T): QuotaRpcResult<T> {
  return { ok: true, data }
}

const reservation = (mode: QuotaMode = 'enforce', reason: ReserveResult['reason'] = null): QuotaRpcResult<ReserveResult> =>
  ok({ allowed: true, mode, reservationId: randomUUID(), reason, replayed: false })

const settled: QuotaRpcResult<SettleResult> = ok({ reservationId: randomUUID(), actualMicros: 1, basis: 'actual', replayed: false })

interface LoadOptions {
  flag?: string
  /** CHAT_ABUSE_GUARDS value; undefined = unset (guards on by default). */
  abuseGuards?: string
  reserve?: ReturnType<typeof vi.fn>
  settle?: ReturnType<typeof vi.fn>
  getStatus?: ReturnType<typeof vi.fn>
  /** Use the REAL quota-repository.ts on top of this mocked supabaseAdmin instead of mocking the repository. */
  realRepositoryWithSupabase?: unknown
  streamAssistantReply?: ReturnType<typeof vi.fn>
  extractStructuredText?: ReturnType<typeof vi.fn>
  createdSession?: Session
}

async function load(options: LoadOptions = {}) {
  vi.resetModules()
  if (options.flag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = options.flag
  if (options.abuseGuards === undefined) delete process.env.CHAT_ABUSE_GUARDS
  else process.env.CHAT_ABUSE_GUARDS = options.abuseGuards

  const sessionRepository = {
    create: vi.fn(() => options.createdSession ?? buildSession()),
    get: vi.fn(),
    // Mutates like the real repository, so the extraction step sees the turns.
    appendTurn: vi.fn((_id: string, turn: ChatTurn, session?: Session) => session?.history.push(turn)),
    setQualification: vi.fn(),
    setOrganization: vi.fn(),
    setConfig: vi.fn(),
  }
  vi.doMock('../src/repositories/session-repository.js', () => ({ sessionRepository }))
  vi.doMock('../src/repositories/usage-events-repository.js', () => ({ recordUsageEvent: vi.fn().mockResolvedValue(undefined) }))
  vi.doMock('../src/repositories/chat-config-repository.js', () => ({
    loadChatConfigurationForOrganization: vi.fn().mockResolvedValue({ status: 'found', config: CONFIG }),
  }))
  vi.doMock('../src/services/organization-lookup.js', () => ({
    resolveOrganizationIdForSlug: vi.fn().mockResolvedValue(RESOLVED),
  }))

  const aiProvider = {
    isConfigured: true,
    streamAssistantReply:
      options.streamAssistantReply ??
      vi.fn(async function* () {
        yield 'Hola '
        yield 'mundo'
        return REPLY
      }),
    extractStructuredText: options.extractStructuredText ?? vi.fn().mockResolvedValue(EXTRACTION),
  }
  const actualProvider = await vi.importActual<typeof import('../src/services/ai-provider.js')>('../src/services/ai-provider.js')
  vi.doMock('../src/services/ai-provider.js', () => ({ ...actualProvider, aiProvider }))

  const quotaRepository = {
    reserve: options.reserve ?? vi.fn().mockResolvedValue(reservation()),
    settle: options.settle ?? vi.fn().mockResolvedValue(settled),
    getStatus: options.getStatus ?? vi.fn().mockResolvedValue(ok({ mode: 'unconfigured', period_start: '2026-10-01' })),
  }
  if (options.realRepositoryWithSupabase !== undefined) {
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: options.realRepositoryWithSupabase }))
  } else {
    vi.doMock('../src/repositories/quota-repository.js', () => ({ quotaRepository }))
  }

  const chatService = await import('../src/services/chat-service.js')
  const { QUOTA_UNAVAILABLE_MESSAGE } = await import('../src/services/quota-service.js')
  const Sdk = (await import('@anthropic-ai/sdk')).default
  return { chatService, sessionRepository, quotaRepository, aiProvider, QUOTA_UNAVAILABLE_MESSAGE, Sdk }
}

/** Binds the mocked appendTurn to a specific session object (mirrors the real repository's shared reference). */
function bindAppend(sessionRepository: { appendTurn: ReturnType<typeof vi.fn> }, session: Session) {
  sessionRepository.appendTurn.mockImplementation((_id: string, turn: ChatTurn) => {
    session.history.push(turn)
  })
}

async function send(loaded: Awaited<ReturnType<typeof load>>, session: Session, message = 'Quiero información', signal = new AbortController().signal) {
  bindAppend(loaded.sessionRepository, session)
  const h = handlers()
  const run = loaded.chatService.handleIncomingMessage(session as never, message, signal, h)
  return { h, run }
}

// ── flag OFF ─────────────────────────────────────────────────────────────

describe('CHAT_QUOTAS_ENABLED off (default)', () => {
  it.each([undefined, '', 'false', '1', 'yes', 'on', 'TRUE ish'])('flag value %j keeps quotas completely out of the flow', async (flag) => {
    const loaded = await load({ flag })
    const session = buildSession()

    const { h, run } = await send(loaded, session)
    await run

    expect(loaded.quotaRepository.reserve).not.toHaveBeenCalled()
    expect(loaded.quotaRepository.settle).not.toHaveBeenCalled()
    expect(loaded.quotaRepository.getStatus).not.toHaveBeenCalled()
    expect(h.onDelta.mock.calls.map(([text]) => text)).toEqual(['Hola ', 'mundo'])
    expect(h.onQualification).toHaveBeenCalledTimes(1)
    expect(h.onQuotaBlocked).not.toHaveBeenCalled()
    expect(session.history).toEqual([
      { role: 'user', content: 'Quiero información' },
      { role: 'assistant', content: 'Hola mundo' },
    ])
  })

  it('createSession never reads the quota mode', async () => {
    const loaded = await load({ flag: 'false' })

    await loaded.chatService.createSession('acme')

    expect(loaded.quotaRepository.getStatus).not.toHaveBeenCalled()
  })

  it('does NOT require the quota migration: with the RPCs missing in the database, the chat still works', async () => {
    const rpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockResolvedValue({ data: null, error: { message: 'function reserve_chat_usage does not exist', code: '42883' } }),
    })
    const loaded = await load({ flag: undefined, realRepositoryWithSupabase: { rpc } })
    const session = buildSession()

    await loaded.chatService.createSession('acme')
    const { h, run } = await send(loaded, session)
    await run

    expect(rpc).not.toHaveBeenCalled()
    expect(h.onDelta).toHaveBeenCalled()
    expect(h.onQualification).toHaveBeenCalled()
  })
})

// ── flag ON ──────────────────────────────────────────────────────────────

describe('CHAT_QUOTAS_ENABLED on — enforce', () => {
  it('reserves BEFORE calling Anthropic and before touching the conversation', async () => {
    const order: string[] = []
    const reserve = vi.fn(async () => {
      order.push('reserve')
      return reservation()
    })
    const streamAssistantReply = vi.fn(async function* () {
      order.push('anthropic')
      yield 'x'
      return REPLY
    })
    const loaded = await load({ flag: 'true', reserve, streamAssistantReply })
    const session = buildSession()
    loaded.sessionRepository.appendTurn.mockImplementation(() => order.push('appendTurn'))

    await loaded.chatService.handleIncomingMessage(session as never, 'hola', new AbortController().signal, handlers())

    expect(order.slice(0, 3)).toEqual(['reserve', 'appendTurn', 'anthropic'])
  })

  it('sends the organization, session, configured model and an estimate bounded by the real max_tokens', async () => {
    const loaded = await load({ flag: 'true' })
    const { MAX_REPLY_TOKENS, MAX_EXTRACTION_TOKENS } = await import('../src/services/ai-provider.js')
    const { config } = await import('../src/config.js')
    const session = buildSession({ history: [{ role: 'user', content: 'previo' }, { role: 'assistant', content: 'respuesta previa' }] })

    const { run } = await send(loaded, session, 'mensaje nuevo ñ😀')
    await run

    const input = loaded.quotaRepository.reserve.mock.calls[0][0]
    expect(input).toMatchObject({ organizationId: ORG_ID, sessionId: session.id, model: config.anthropicModel })
    expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(input.maxOutputTokens).toBe(MAX_REPLY_TOKENS + MAX_EXTRACTION_TOKENS)
  })

  it('the input estimate covers every byte actually sent to both calls', async () => {
    let replySystem = ''
    let replyHistory: ChatTurn[] = []
    let extractionSystem = ''
    let extractionTranscript = ''
    const streamAssistantReply = vi.fn(async function* (params: { systemPrompt: string; history: ChatTurn[] }) {
      replySystem = params.systemPrompt
      replyHistory = [...params.history]
      yield 'Respuesta del asistente con acentos: ñáé'
      return { ...REPLY, text: 'Respuesta del asistente con acentos: ñáé' }
    })
    const extractStructuredText = vi.fn(async (params: { systemPrompt: string; transcript: string }) => {
      extractionSystem = params.systemPrompt
      extractionTranscript = params.transcript
      return EXTRACTION
    })
    const loaded = await load({ flag: 'true', streamAssistantReply, extractStructuredText })
    const { buildExtractionUserContent } = await import('../src/services/ai-provider.js')
    const session = buildSession({ history: [{ role: 'user', content: 'hola 😀' }, { role: 'assistant', content: 'buenas' }] })

    const { run } = await send(loaded, session, 'quiero un presupuesto')
    await run

    const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
    const actuallySentBytes =
      bytes(replySystem) +
      replyHistory.reduce((sum, turn) => sum + bytes(turn.content), 0) +
      bytes(extractionSystem) +
      bytes(buildExtractionUserContent(extractionTranscript))
    expect(loaded.quotaRepository.reserve.mock.calls[0][0].estimatedInputTokens).toBeGreaterThanOrEqual(actuallySentBytes)
  })

  it('settles with the REAL combined usage of both calls', async () => {
    const loaded = await load({ flag: 'true' })
    const reserved = reservation()
    loaded.quotaRepository.reserve.mockResolvedValue(reserved)
    const session = buildSession()

    const { run } = await send(loaded, session)
    await run

    expect(loaded.quotaRepository.settle).toHaveBeenCalledTimes(1)
    expect(loaded.quotaRepository.settle.mock.calls[0][0]).toEqual({
      reservationId: (reserved as { data: ReserveResult }).data.reservationId,
      inputTokens: 250,
      outputTokens: 60,
      model: 'm-1',
    })
  })

  it('a reply that reports prompt-cache tokens is settled at its upper bound, never at its (undercounted) real input', async () => {
    const streamAssistantReply = vi.fn(async function* () {
      yield 'Hola'
      return { ...REPLY, usage: { ...REPLY.usage, cacheCreationInputTokens: 0, cacheReadInputTokens: 5_000 } }
    })
    const loaded = await load({ flag: 'true', streamAssistantReply })
    const { MAX_REPLY_TOKENS } = await import('../src/services/ai-provider.js')
    const session = buildSession()

    const { run } = await send(loaded, session)
    await run

    const reserveInput = loaded.quotaRepository.reserve.mock.calls[0][0]
    const settled = loaded.quotaRepository.settle.mock.calls[0][0]
    // Reply → its bound (max_tokens output, byte-bounded input); extraction → its real 150/40.
    expect(settled.outputTokens).toBe(MAX_REPLY_TOKENS + 40)
    expect(settled.inputTokens).toBeGreaterThan(100 + 150)
    expect(settled.inputTokens).toBeLessThanOrEqual(reserveInput.estimatedInputTokens)
    expect(settled.model).toBe('m-1')
  })

  it('a DENIED reservation: no Anthropic call, conversation untouched, calm generic message, nothing settled', async () => {
    const reserve = vi.fn().mockResolvedValue(ok({ allowed: false, mode: 'enforce', reservationId: null, reason: 'budget_exhausted', replayed: false }))
    const loaded = await load({ flag: 'true', reserve })
    const session = buildSession({ history: [{ role: 'user', content: 'previo' }] })

    const { h, run } = await send(loaded, session)
    await run

    expect(loaded.aiProvider.streamAssistantReply).not.toHaveBeenCalled()
    expect(loaded.aiProvider.extractStructuredText).not.toHaveBeenCalled()
    expect(loaded.sessionRepository.appendTurn).not.toHaveBeenCalled()
    expect(loaded.sessionRepository.setQualification).not.toHaveBeenCalled()
    expect(session.history).toEqual([{ role: 'user', content: 'previo' }])
    expect(h.onQuotaBlocked).toHaveBeenCalledWith(loaded.QUOTA_UNAVAILABLE_MESSAGE)
    expect(h.onLimitReached).not.toHaveBeenCalled()
    expect(h.onDelta).not.toHaveBeenCalled()
    expect(loaded.quotaRepository.settle).not.toHaveBeenCalled()
  })

  it.each([
    ['current SQL (allowed=false)', { allowed: false, mode: 'unconfigured', reservationId: null, reason: 'quota_not_configured', replayed: false }],
    ['older SQL (allowed=true)', { allowed: true, mode: 'unconfigured', reservationId: null, reason: null, replayed: false }],
  ] as const)('an organization with NO quota row is never unlimited — %s: blocked before Anthropic', async (_label, answer) => {
    const reserve = vi.fn().mockResolvedValue(ok(answer))
    const loaded = await load({ flag: 'true', reserve })
    const session = buildSession({ history: [{ role: 'user', content: 'previo' }] })

    const { h, run } = await send(loaded, session)
    await run

    expect(loaded.aiProvider.streamAssistantReply).not.toHaveBeenCalled()
    expect(loaded.aiProvider.extractStructuredText).not.toHaveBeenCalled()
    expect(loaded.sessionRepository.appendTurn).not.toHaveBeenCalled()
    expect(session.history).toEqual([{ role: 'user', content: 'previo' }])
    expect(h.onQuotaBlocked).toHaveBeenCalledWith(loaded.QUOTA_UNAVAILABLE_MESSAGE)
    expect(loaded.quotaRepository.settle).not.toHaveBeenCalled()
  })

  it('the technical message limit is still checked FIRST — no reservation is attempted past it', async () => {
    const loaded = await load({ flag: 'true' })
    const history = Array.from({ length: 25 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }))
    const session = buildSession({ history })

    const { h, run } = await send(loaded, session)
    await run

    expect(h.onLimitReached).toHaveBeenCalled()
    expect(loaded.quotaRepository.reserve).not.toHaveBeenCalled()
  })
})

describe('CHAT_QUOTAS_ENABLED on — shadow / off / not attributed', () => {
  it('shadow never blocks (even when enforce would) and still settles real usage', async () => {
    const reserve = vi.fn().mockResolvedValue(reservation('shadow', 'budget_exhausted'))
    const loaded = await load({ flag: 'true', reserve })
    const session = buildSession()

    const { h, run } = await send(loaded, session)
    await run

    expect(h.onQuotaBlocked).not.toHaveBeenCalled()
    expect(h.onDelta).toHaveBeenCalled()
    expect(loaded.quotaRepository.settle).toHaveBeenCalledTimes(1)
  })

  it("an 'off' organization behaves exactly as before: nothing reserved, nothing settled", async () => {
    const reserve = vi.fn().mockResolvedValue(ok({ allowed: true, mode: 'off', reservationId: null, reason: null, replayed: false }))
    const loaded = await load({ flag: 'true', reserve })
    const session = buildSession()

    const { h, run } = await send(loaded, session)
    await run

    expect(h.onDelta.mock.calls.map(([t]) => t)).toEqual(['Hola ', 'mundo'])
    expect(loaded.quotaRepository.settle).not.toHaveBeenCalled()
  })

  it('local/dev sessions (not_configured) are never metered', async () => {
    const loaded = await load({ flag: 'true' })
    const session = buildSession({ organization: { status: 'not_configured' }, configSource: 'local' })

    const { run } = await send(loaded, session)
    await run

    expect(loaded.quotaRepository.reserve).not.toHaveBeenCalled()
  })
})

// ── failures ─────────────────────────────────────────────────────────────

describe('CHAT_QUOTAS_ENABLED on — Supabase failures', () => {
  const down = () => vi.fn().mockResolvedValue({ ok: false, kind: 'transient', message: 'down' })

  it.each([undefined, 'enforce', 'off', 'shadow', 'unconfigured'] as const)(
    'FAILS CLOSED for every session (legacy stored mode: %s): throws before Anthropic, conversation untouched, nothing charged',
    async (quotaMode) => {
      const loaded = await load({ flag: 'true', reserve: down() })
      const session = buildSession({ quotaMode })

      const { h, run } = await send(loaded, session)

      await expect(run).rejects.toThrow()
      expect(loaded.quotaRepository.reserve).toHaveBeenCalledTimes(2) // one internal retry, same request id
      expect(loaded.aiProvider.streamAssistantReply).not.toHaveBeenCalled()
      expect(loaded.aiProvider.extractStructuredText).not.toHaveBeenCalled()
      expect(loaded.sessionRepository.appendTurn).not.toHaveBeenCalled()
      expect(loaded.quotaRepository.settle).not.toHaveBeenCalled()
      expect(h.onDelta).not.toHaveBeenCalled()
    },
  )

  it('the migration NOT applied + flag on: fails closed through the REAL repository, Anthropic never called', async () => {
    const rpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockResolvedValue({ data: null, error: { message: 'function does not exist', code: '42883' } }),
    })
    const loaded = await load({ flag: 'true', realRepositoryWithSupabase: { rpc } })
    const session = buildSession()

    const { run } = await send(loaded, session)

    await expect(run).rejects.toThrow()
    expect(rpc).toHaveBeenCalledTimes(1) // 'rejected' is not retried
    expect(loaded.aiProvider.streamAssistantReply).not.toHaveBeenCalled()
  })

  it('a failed settlement never breaks a reply the visitor already received', async () => {
    const loaded = await load({ flag: 'true', settle: down() })
    const session = buildSession()

    const { h, run } = await send(loaded, session)
    await expect(run).resolves.toBeUndefined()

    expect(h.onDelta).toHaveBeenCalled()
    expect(h.onQualification).toHaveBeenCalled()
    expect(loaded.quotaRepository.settle).toHaveBeenCalledTimes(2) // one internal retry, same reservation
  })
})

// ── stream / Anthropic failures: per-call settlement (risk E.1) ──────────

type Loaded = Awaited<ReturnType<typeof load>>
const httpError = (loaded: Loaded, status: number, type: string) =>
  loaded.Sdk.APIError.generate(status, { type: 'error', error: { type, message: 'x' } }, undefined, new Headers({ 'request-id': 'req_test' }))

/** An async iterator whose very first next() rejects — what the SDK stream does when the HTTP response itself is an error. */
const failsBeforeOutput = (error: unknown) => () => ({ next: () => Promise.reject(error) })

function settledWith(loaded: Loaded) {
  expect(loaded.quotaRepository.settle).toHaveBeenCalledTimes(1)
  return loaded.quotaRepository.settle.mock.calls[0][0] as { inputTokens: number | null; outputTokens: number | null; model: string | null }
}
function reserved(loaded: Loaded) {
  return loaded.quotaRepository.reserve.mock.calls[0][0] as { estimatedInputTokens: number; maxOutputTokens: number }
}

describe('CHAT_QUOTAS_ENABLED on — settlement per failure type', () => {
  it('401 before the reply starts → confirmed unbilled → settles ZERO; extraction never called', async () => {
    const loaded = await load({ flag: 'true' })
    loaded.aiProvider.streamAssistantReply.mockImplementation(failsBeforeOutput(httpError(loaded, 401, 'authentication_error')))

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    expect(settledWith(loaded)).toEqual({ reservationId: expect.any(String), inputTokens: 0, outputTokens: 0, model: null })
    expect(loaded.aiProvider.extractStructuredText).not.toHaveBeenCalled()
  })

  it('413 before the reply starts → confirmed unbilled → settles ZERO', async () => {
    const loaded = await load({ flag: 'true' })
    loaded.aiProvider.streamAssistantReply.mockImplementation(failsBeforeOutput(httpError(loaded, 413, 'request_too_large')))

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    expect(settledWith(loaded)).toMatchObject({ inputTokens: 0, outputTokens: 0 })
  })

  it.each([
    [429, 'rate_limit_error'],
    [529, 'overloaded_error'],
    [500, 'api_error'],
    [400, 'invalid_request_error'],
  ])('%i before the reply starts → NOT confirmed → keeps the REPLY bound only (extraction never made)', async (status, type) => {
    const loaded = await load({ flag: 'true' })
    loaded.aiProvider.streamAssistantReply.mockImplementation(failsBeforeOutput(httpError(loaded, status, type)))
    const { MAX_REPLY_TOKENS } = await import('../src/services/ai-provider.js')

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    const settled = settledWith(loaded)
    expect(settled.outputTokens).toBe(MAX_REPLY_TOKENS)
    expect(settled.inputTokens).toBeGreaterThan(0)
    expect(settled.inputTokens).toBeLessThan(reserved(loaded).estimatedInputTokens)
    expect(loaded.aiProvider.extractStructuredText).not.toHaveBeenCalled()
  })

  it('timeout before any response → unknown → keeps the reply bound', async () => {
    const loaded = await load({ flag: 'true' })
    loaded.aiProvider.streamAssistantReply.mockImplementation(failsBeforeOutput(new loaded.Sdk.APIConnectionTimeoutError()))
    const { MAX_REPLY_TOKENS } = await import('../src/services/ai-provider.js')

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    expect(settledWith(loaded)).toMatchObject({ outputTokens: MAX_REPLY_TOKENS })
  })

  it('visitor disconnects DURING streaming (abort after output) → unknown → keeps the reply bound', async () => {
    const loaded = await load({ flag: 'true' })
    loaded.aiProvider.streamAssistantReply.mockImplementation(async function* () {
      yield 'Hola '
      throw new loaded.Sdk.APIUserAbortError()
    })
    const { MAX_REPLY_TOKENS } = await import('../src/services/ai-provider.js')

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    expect(settledWith(loaded)).toMatchObject({ outputTokens: MAX_REPLY_TOKENS })
    expect(loaded.aiProvider.extractStructuredText).not.toHaveBeenCalled()
  })

  it('an error AFTER partial streaming is never zero — even if it looked like a 401', async () => {
    const loaded = await load({ flag: 'true' })
    const lateError = httpError(loaded, 401, 'authentication_error')
    loaded.aiProvider.streamAssistantReply.mockImplementation(async function* () {
      yield 'texto parcial'
      throw lateError
    })
    const { MAX_REPLY_TOKENS } = await import('../src/services/ai-provider.js')

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    expect(settledWith(loaded)).toMatchObject({ outputTokens: MAX_REPLY_TOKENS })
  })

  it('mid-stream SSE error event (status undefined) → unknown → keeps the reply bound', async () => {
    const loaded = await load({ flag: 'true' })
    const midStream = new loaded.Sdk.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, undefined, new Headers())
    loaded.aiProvider.streamAssistantReply.mockImplementation(async function* () {
      yield 'Hola'
      throw midStream
    })
    const { MAX_REPLY_TOKENS } = await import('../src/services/ai-provider.js')

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    expect(settledWith(loaded)).toMatchObject({ outputTokens: MAX_REPLY_TOKENS })
  })

  it('reply COMPLETED + extraction failed (unknown) → reply real usage + extraction bound, never zero, never the whole estimate', async () => {
    const loaded = await load({ flag: 'true' })
    loaded.aiProvider.extractStructuredText.mockRejectedValue(new loaded.Sdk.APIConnectionTimeoutError())
    const { MAX_EXTRACTION_TOKENS } = await import('../src/services/ai-provider.js')

    const { h, run } = await send(loaded, buildSession())
    await run

    expect(h.onDelta).toHaveBeenCalled()
    expect(h.onQualification).toHaveBeenCalledWith(null)
    const settled = settledWith(loaded)
    expect(settled.outputTokens).toBe(REPLY.usage.outputTokens + MAX_EXTRACTION_TOKENS)
    expect(settled.inputTokens).toBeGreaterThan(REPLY.usage.inputTokens)
    expect(settled.inputTokens).toBeLessThan(reserved(loaded).estimatedInputTokens)
    expect(settled.model).toBe(REPLY.model)
  })

  it('reply COMPLETED + extraction rejected with 401 → reply real usage only', async () => {
    const loaded = await load({ flag: 'true' })
    loaded.aiProvider.extractStructuredText.mockRejectedValue(httpError(loaded, 401, 'authentication_error'))

    const { run } = await send(loaded, buildSession())
    await run

    expect(settledWith(loaded)).toMatchObject({ inputTokens: REPLY.usage.inputTokens, outputTokens: REPLY.usage.outputTokens, model: REPLY.model })
  })

  it('an extraction whose text is unparseable still settles its REAL usage (the call itself succeeded)', async () => {
    const extractStructuredText = vi.fn().mockResolvedValue({ ...EXTRACTION, text: 'not json' })
    const loaded = await load({ flag: 'true', extractStructuredText })

    const { run } = await send(loaded, buildSession())
    await run

    expect(settledWith(loaded)).toMatchObject({ inputTokens: 250, outputTokens: 60 })
  })

  it('calls reporting different models keep the whole estimate (null)', async () => {
    const extractStructuredText = vi.fn().mockResolvedValue({ ...EXTRACTION, model: 'other-model' })
    const loaded = await load({ flag: 'true', extractStructuredText })

    const { run } = await send(loaded, buildSession())
    await run

    expect(settledWith(loaded)).toMatchObject({ inputTokens: null, outputTokens: null })
  })

  it('a non-SDK error before output (e.g. plain Error) → unknown → reply bound, never zero', async () => {
    const loaded = await load({ flag: 'true' })
    loaded.aiProvider.streamAssistantReply.mockImplementation(failsBeforeOutput(new Error('401 looks like auth but is not an SDK HTTP error')))

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    expect(settledWith(loaded).outputTokens).toBeGreaterThan(0)
  })

  it('Supabase failing to SETTLE a zero-cost rejection never breaks the request flow (reservation stays at its estimate)', async () => {
    const loaded = await load({ flag: 'true', settle: vi.fn().mockResolvedValue({ ok: false, kind: 'transient', message: 'down' }) })
    loaded.aiProvider.streamAssistantReply.mockImplementation(failsBeforeOutput(httpError(loaded, 401, 'authentication_error')))

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow() // the original Anthropic error — not a settlement error

    expect(loaded.quotaRepository.settle).toHaveBeenCalledTimes(2) // one internal retry, same reservation
  })

  it('flag OFF: failures are not classified at all (no reservation, nothing settled)', async () => {
    const loaded = await load({ flag: 'false' })
    loaded.aiProvider.streamAssistantReply.mockImplementation(failsBeforeOutput(httpError(loaded, 401, 'authentication_error')))

    const { run } = await send(loaded, buildSession())
    await expect(run).rejects.toThrow()

    expect(loaded.quotaRepository.reserve).not.toHaveBeenCalled()
    expect(loaded.quotaRepository.settle).not.toHaveBeenCalled()
  })
})

// ── idempotency boundaries ───────────────────────────────────────────────

describe('idempotency boundaries', () => {
  it('an INTERNAL Supabase retry reuses the same request id and yields a single Anthropic call', async () => {
    const reserve = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, kind: 'transient', message: 'timeout' })
      .mockResolvedValueOnce(reservation())
    const loaded = await load({ flag: 'true', reserve })
    const session = buildSession()

    const { run } = await send(loaded, session)
    await run

    expect(reserve).toHaveBeenCalledTimes(2)
    expect(reserve.mock.calls[0][0].requestId).toBe(reserve.mock.calls[1][0].requestId)
    expect(loaded.aiProvider.streamAssistantReply).toHaveBeenCalledTimes(1)
  })

  it('a BROWSER re-send is a new HTTP request: new request id, new reservation (it triggers new Anthropic calls)', async () => {
    const loaded = await load({ flag: 'true' })
    const session = buildSession()

    await (await send(loaded, session, 'hola')).run
    await (await send(loaded, session, 'hola')).run

    const [first, second] = loaded.quotaRepository.reserve.mock.calls.map(([input]) => input.requestId)
    expect(first).not.toBe(second)
    expect(loaded.aiProvider.streamAssistantReply).toHaveBeenCalledTimes(2)
    expect(loaded.quotaRepository.settle).toHaveBeenCalledTimes(2)
  })
})

// ── Fase 4: new-conversation pre-check ───────────────────────────────────

function enforceStatus(overrides: Record<string, unknown> = {}) {
  return ok({
    mode: 'enforce',
    status: 'active',
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
  })
}

describe('createSession — quota pre-check (flag on)', () => {
  it('organization with quota available: session created WITHOUT reserving, counting or charging anything', async () => {
    const getStatus = vi.fn().mockResolvedValue(enforceStatus())
    const loaded = await load({ flag: 'true', getStatus })

    await expect(loaded.chatService.createSession('acme')).resolves.toBeDefined()

    const { config } = await import('../src/config.js')
    // Asked WITH the configured model, so a missing price is caught here.
    expect(getStatus).toHaveBeenCalledWith(ORG_ID, config.anthropicModel)
    expect(loaded.sessionRepository.create).toHaveBeenCalledTimes(1)
    expect(loaded.quotaRepository.reserve).not.toHaveBeenCalled()
    expect(loaded.quotaRepository.settle).not.toHaveBeenCalled()
    expect(loaded.aiProvider.streamAssistantReply).not.toHaveBeenCalled()
  })

  it.each([
    ['budget exhausted', { settled_micros: 1_000 }],
    ['suspended', { status: 'suspended' }],
    ['conversations exhausted', { conversations_used: 10 }],
    ['limits not configured', { budget_micros: null }],
  ])('%s: refused with 403 and ONLY the generic, friendly message; no session is created', async (_label, overrides) => {
    const getStatus = vi.fn().mockResolvedValue(enforceStatus(overrides))
    const loaded = await load({ flag: 'true', getStatus })

    await expect(loaded.chatService.createSession('acme')).rejects.toMatchObject({
      status: 403,
      publicMessage: loaded.QUOTA_UNAVAILABLE_MESSAGE,
    })
    expect(loaded.sessionRepository.create).not.toHaveBeenCalled()
    expect(loaded.aiProvider.streamAssistantReply).not.toHaveBeenCalled()
  })

  it('organization with NO quota row: refused with 403 and only the generic message; no session is created', async () => {
    const getStatus = vi.fn().mockResolvedValue(ok({ mode: 'unconfigured', period_start: '2026-10-01' }))
    const loaded = await load({ flag: 'true', getStatus })

    await expect(loaded.chatService.createSession('acme')).rejects.toMatchObject({
      status: 403,
      publicMessage: loaded.QUOTA_UNAVAILABLE_MESSAGE,
    })
    expect(loaded.sessionRepository.create).not.toHaveBeenCalled()
  })

  it('EXPLICIT off organization (no limits configured): session created exactly as before', async () => {
    const getStatus = vi.fn().mockResolvedValue(enforceStatus({ mode: 'off', conversation_limit: null, budget_micros: null }))
    const loaded = await load({ flag: 'true', getStatus })

    await expect(loaded.chatService.createSession('acme')).resolves.toBeDefined()
    expect(loaded.sessionRepository.create).toHaveBeenCalledTimes(1)
  })

  it('enforce organization WITHOUT a price for the configured model: refused with 403 and only the generic message; no session', async () => {
    const getStatus = vi.fn().mockResolvedValue(enforceStatus({ model_price_configured: false }))
    const loaded = await load({ flag: 'true', getStatus })

    await expect(loaded.chatService.createSession('acme')).rejects.toMatchObject({
      status: 403,
      publicMessage: loaded.QUOTA_UNAVAILABLE_MESSAGE,
    })
    expect(loaded.sessionRepository.create).not.toHaveBeenCalled()
  })

  it('shadow organization WITHOUT a price: session still created (never blocked), the gap is logged', async () => {
    const getStatus = vi.fn().mockResolvedValue(enforceStatus({ mode: 'shadow', model_price_configured: false }))
    const loaded = await load({ flag: 'true', getStatus })

    await expect(loaded.chatService.createSession('acme')).resolves.toBeDefined()
    expect(loaded.sessionRepository.create).toHaveBeenCalledTimes(1)
  })

  it('shadow organization: never refused at creation, even when exhausted', async () => {
    const getStatus = vi.fn().mockResolvedValue(enforceStatus({ mode: 'shadow', settled_micros: 5_000 }))
    const loaded = await load({ flag: 'true', getStatus })

    await expect(loaded.chatService.createSession('acme')).resolves.toBeDefined()
  })

  it('Supabase unavailable: refused with 503 and a retryable message that reveals nothing technical', async () => {
    const getStatus = vi.fn().mockResolvedValue({ ok: false, kind: 'transient', message: 'connect ECONNREFUSED supabase' })
    const loaded = await load({ flag: 'true', getStatus })
    const { QUOTA_TEMPORARY_ERROR_MESSAGE } = await import('../src/services/quota-service.js')

    const error = await loaded.chatService.createSession('acme').catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 503, publicMessage: QUOTA_TEMPORARY_ERROR_MESSAGE })
    expect((error as { publicMessage: string }).publicMessage).not.toMatch(/supabase|ECONN|transient/i)
    expect(loaded.sessionRepository.create).not.toHaveBeenCalled()
  })
})

// ── Fase 4: stale per-session state is never trusted ─────────────────────

describe('old sessions whose organization changed mode', () => {
  it('a session stored as "off" whose organization is now enforce + exhausted is blocked by the live answer', async () => {
    const reserve = vi.fn().mockResolvedValue(ok({ allowed: false, mode: 'enforce', reservationId: null, reason: 'budget_exhausted', replayed: false }))
    const loaded = await load({ flag: 'true', reserve })
    const session = buildSession({ quotaMode: 'off', history: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'buenas' }] })

    const { h, run } = await send(loaded, session)
    await run

    expect(h.onQuotaBlocked).toHaveBeenCalledWith(loaded.QUOTA_UNAVAILABLE_MESSAGE)
    expect(loaded.aiProvider.streamAssistantReply).not.toHaveBeenCalled()
    expect(session.history).toHaveLength(2)
  })

  it('a session stored as "off" during an outage is NOT let through on that stale value', async () => {
    const reserve = vi.fn().mockResolvedValue({ ok: false, kind: 'transient', message: 'down' })
    const loaded = await load({ flag: 'true', reserve })
    const session = buildSession({ quotaMode: 'off' })

    const { run } = await send(loaded, session)

    await expect(run).rejects.toThrow()
    expect(loaded.aiProvider.streamAssistantReply).not.toHaveBeenCalled()
  })
})

// ── Fase 4: concurrency ──────────────────────────────────────────────────

describe('simultaneous requests', () => {
  it('two simultaneous messages of DIFFERENT sessions with budget for one: exactly one reaches Anthropic', async () => {
    let remaining = 1
    // Atomic like the SQL function: decide and consume in one step, after yielding to the other request.
    const reserve = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (remaining <= 0) return ok({ allowed: false, mode: 'enforce', reservationId: null, reason: 'budget_exhausted', replayed: false })
      remaining -= 1
      return reservation()
    })
    const loaded = await load({ flag: 'true', reserve })
    const first = buildSession()
    const second = buildSession()

    const a = await send(loaded, first)
    const b = await send(loaded, second)
    await Promise.all([a.run, b.run])

    expect(loaded.aiProvider.streamAssistantReply).toHaveBeenCalledTimes(1)
    expect([a.h.onQuotaBlocked.mock.calls.length, b.h.onQuotaBlocked.mock.calls.length].sort()).toEqual([0, 1])
    expect(loaded.quotaRepository.settle).toHaveBeenCalledTimes(1)
  })

  it('the SAME session cannot process two messages at once while quotas are on', async () => {
    const loaded = await load({ flag: 'true' })
    const sessionId = randomUUID()

    const release = loaded.chatService.tryBeginSessionTurn(sessionId)
    expect(release).not.toBeNull()
    expect(loaded.chatService.tryBeginSessionTurn(sessionId)).toBeNull()
    expect(loaded.chatService.tryBeginSessionTurn(randomUUID())).not.toBeNull() // other sessions unaffected

    release!()
    release!() // idempotent
    expect(loaded.chatService.tryBeginSessionTurn(sessionId)).not.toBeNull()
  })

  it('quotas off but abuse guards on (the default): the same session still cannot process two messages at once', async () => {
    const loaded = await load({ flag: 'false' })
    const sessionId = randomUUID()

    const release = loaded.chatService.tryBeginSessionTurn(sessionId)
    expect(release).not.toBeNull()
    expect(loaded.chatService.tryBeginSessionTurn(sessionId)).toBeNull()
    expect(loaded.chatService.tryBeginSessionTurn(randomUUID())).not.toBeNull()
    release!()
    expect(loaded.chatService.tryBeginSessionTurn(sessionId)).not.toBeNull()
  })

  it('with quotas off AND CHAT_ABUSE_GUARDS=off (emergency switch), the per-session guard never refuses', async () => {
    const loaded = await load({ flag: 'false', abuseGuards: 'off' })
    const sessionId = randomUUID()

    expect(loaded.chatService.tryBeginSessionTurn(sessionId)).not.toBeNull()
    expect(loaded.chatService.tryBeginSessionTurn(sessionId)).not.toBeNull()
  })
})

// ── Fase 4: estimate observability ───────────────────────────────────────

describe('estimate vs real usage', () => {
  it('logs (never blocks, never alters the charge) when real usage exceeds the reserved estimate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const huge = { ...REPLY, usage: { inputTokens: 50_000_000, outputTokens: 20 } }
    const streamAssistantReply = vi.fn(async function* () {
      yield 'x'
      return huge
    })
    const loaded = await load({ flag: 'true', streamAssistantReply })
    const session = buildSession()

    const { run } = await send(loaded, session)
    await run

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Quota estimate was exceeded'), expect.anything())
    expect(loaded.quotaRepository.settle.mock.calls[0][0]).toMatchObject({ inputTokens: 50_000_150 })
    warn.mockRestore()
  })

  it('stays silent when real usage is within the estimate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loaded = await load({ flag: 'true' })

    const { run } = await send(loaded, buildSession())
    await run

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Quota estimate was exceeded'), expect.anything())
    warn.mockRestore()
  })
})
