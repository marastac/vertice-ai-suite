import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatConfigurationInput } from '../src/schemas/chat.js'
import type { ChatTurn } from '../src/services/ai-provider.js'

// hasReachedMessageLimit()/handleIncomingMessage() back the technical
// message-count protection on POST /sessions/:sessionId/messages —
// extracted into chat-service.ts specifically so this is testable without
// an HTTP harness (this project has none), same reasoning as
// routes/hubspot.ts's handleOauthCallback()/disconnectHubspotConnection().
// Every real dependency (session storage, the Anthropic provider) is
// mocked via vi.doMock() so these tests exercise only the decision logic:
// what gets called, in what order, and — critically — what does NOT get
// called once the limit is reached.

const ENV_KEY = 'CHAT_MAX_USER_MESSAGES'
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  vi.resetModules()
  vi.doUnmock('../src/repositories/session-repository.js')
  vi.doUnmock('../src/services/ai-provider.js')
})

const FIXTURE_CONFIG: ChatConfigurationInput = {
  assistantName: 'Asistente de prueba',
  welcomeMessage: 'Hola, ¿en qué puedo ayudarte?',
  agencyDescription: '',
  servicesOffered: '',
  tone: 'professional',
  language: 'Español',
  questionsToCollect: [],
  criteria: [],
  minQualifiedScore: 70,
  isActive: true,
}

function buildSession(history: ChatTurn[]) {
  return {
    id: 'session-1',
    orgSlug: 'test-org',
    config: FIXTURE_CONFIG,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    history,
  }
}

function userTurns(n: number): ChatTurn[] {
  return Array.from({ length: n }, (_, i) => ({ role: 'user' as const, content: `mensaje ${i + 1}` }))
}

function assistantTurns(n: number): ChatTurn[] {
  return Array.from({ length: n }, (_, i) => ({ role: 'assistant' as const, content: `respuesta ${i + 1}` }))
}

interface Mocks {
  appendTurn?: ReturnType<typeof vi.fn>
  setQualification?: ReturnType<typeof vi.fn>
  streamAssistantReply?: ReturnType<typeof vi.fn>
  extractStructuredText?: ReturnType<typeof vi.fn>
}

async function loadChatServiceWithMocks(mocks: Mocks = {}) {
  vi.resetModules()

  vi.doMock('../src/repositories/session-repository.js', () => ({
    sessionRepository: {
      create: vi.fn(),
      get: vi.fn(),
      appendTurn: mocks.appendTurn ?? vi.fn(),
      setQualification: mocks.setQualification ?? vi.fn(),
    },
  }))

  vi.doMock('../src/services/ai-provider.js', () => ({
    aiProvider: {
      isConfigured: true,
      streamAssistantReply:
        mocks.streamAssistantReply ??
        vi.fn(async function* () {
          yield 'Hola '
          yield 'mundo'
          return 'Hola mundo'
        }),
      extractStructuredText: mocks.extractStructuredText ?? vi.fn().mockResolvedValue('{}'),
    },
  }))

  return import('../src/services/chat-service.js')
}

describe('hasReachedMessageLimit — counts ONLY role: "user" turns, default limit is 25', () => {
  it('returns false when fewer user turns than the limit (default 25) — message #25 is still allowed', async () => {
    delete process.env[ENV_KEY]
    const { hasReachedMessageLimit } = await loadChatServiceWithMocks()
    // 24 user turns already on file — the 25th attempt must be allowed.
    expect(hasReachedMessageLimit(buildSession(userTurns(24)))).toBe(false)
  })

  it('returns true once the user-turn count reaches the limit (default 25) — attempt #26 is blocked', async () => {
    delete process.env[ENV_KEY]
    const { hasReachedMessageLimit } = await loadChatServiceWithMocks()
    // 25 user turns already on file (the 25th message already completed) — the next attempt is #26.
    expect(hasReachedMessageLimit(buildSession(userTurns(25)))).toBe(true)
  })

  it('assistant turns never count toward the limit', async () => {
    process.env[ENV_KEY] = '5'
    const { hasReachedMessageLimit } = await loadChatServiceWithMocks()
    // 4 user turns + a large number of assistant turns — still under the limit of 5.
    const session = buildSession([...userTurns(4), ...assistantTurns(50)])
    expect(hasReachedMessageLimit(session)).toBe(false)
  })

  it('a pre-existing session already over a newly-lowered limit is blocked, with no migration needed', async () => {
    // Simulates a conversation that grew long BEFORE this limit existed —
    // the count is computed live from session.history already on file, no
    // backfill/migration required.
    process.env[ENV_KEY] = '5'
    const { hasReachedMessageLimit } = await loadChatServiceWithMocks()
    expect(hasReachedMessageLimit(buildSession(userTurns(40)))).toBe(true)
  })

  it('falls back to 25 for an unset/invalid CHAT_MAX_USER_MESSAGES value', async () => {
    process.env[ENV_KEY] = 'not-a-number'
    const { hasReachedMessageLimit } = await loadChatServiceWithMocks()
    expect(hasReachedMessageLimit(buildSession(userTurns(24)))).toBe(false)
    expect(hasReachedMessageLimit(buildSession(userTurns(25)))).toBe(true)
  })
})

describe('handleIncomingMessage — the limit check runs BEFORE anything else', () => {
  it('under the limit: streams normally, calls onDelta/onQualification, never onLimitReached', async () => {
    process.env[ENV_KEY] = '3'
    const appendTurn = vi.fn()
    const setQualification = vi.fn()
    const { handleIncomingMessage } = await loadChatServiceWithMocks({ appendTurn, setQualification })

    const session = buildSession(userTurns(2)) // 2 of 3 used — this message is allowed
    const onDelta = vi.fn()
    const onQualification = vi.fn()
    const onLimitReached = vi.fn()

    await handleIncomingMessage(session, 'hola', new AbortController().signal, { onDelta, onQualification, onLimitReached })

    expect(onLimitReached).not.toHaveBeenCalled()
    expect(onDelta).toHaveBeenCalledWith('Hola ')
    expect(onDelta).toHaveBeenCalledWith('mundo')
    expect(onQualification).toHaveBeenCalledTimes(1)
    // The normal flow DOES append turns — proving the mocks/flow work as
    // expected, and giving the next test something real to contrast against.
    expect(appendTurn).toHaveBeenCalledWith('session-1', { role: 'user', content: 'hola' })
    expect(appendTurn).toHaveBeenCalledWith('session-1', { role: 'assistant', content: 'Hola mundo' })
  })

  it('AT the limit: calls onLimitReached with the exact closing message, and NOTHING else', async () => {
    process.env[ENV_KEY] = '3'
    const appendTurn = vi.fn()
    const setQualification = vi.fn()
    const streamAssistantReply = vi.fn()
    const extractStructuredText = vi.fn()
    const { handleIncomingMessage, CONVERSATION_LIMIT_MESSAGE } = await loadChatServiceWithMocks({
      appendTurn,
      setQualification,
      streamAssistantReply,
      extractStructuredText,
    })

    const session = buildSession(userTurns(3)) // already at the limit — this would be attempt #4
    const onDelta = vi.fn()
    const onQualification = vi.fn()
    const onLimitReached = vi.fn()

    await handleIncomingMessage(session, 'un mensaje de más', new AbortController().signal, {
      onDelta,
      onQualification,
      onLimitReached,
    })

    // 1) The visitor gets a controlled, calm closing message.
    expect(onLimitReached).toHaveBeenCalledTimes(1)
    expect(onLimitReached).toHaveBeenCalledWith(CONVERSATION_LIMIT_MESSAGE)

    // 2) Anthropic is NEVER called — no tokens spent.
    expect(streamAssistantReply).not.toHaveBeenCalled()
    expect(extractStructuredText).not.toHaveBeenCalled()

    // 3) The rejected attempt is NEVER stored as a valid message.
    expect(appendTurn).not.toHaveBeenCalled()

    // 4) The existing qualification is left exactly as it was.
    expect(setQualification).not.toHaveBeenCalled()

    // 5) No normal-flow callbacks fire either.
    expect(onDelta).not.toHaveBeenCalled()
    expect(onQualification).not.toHaveBeenCalled()
  })

  it('an old session already OVER the limit is blocked on its next attempt — no migration needed', async () => {
    process.env[ENV_KEY] = '3'
    const streamAssistantReply = vi.fn()
    const { handleIncomingMessage } = await loadChatServiceWithMocks({ streamAssistantReply })

    const session = buildSession(userTurns(10)) // grew past the limit before it existed
    const onLimitReached = vi.fn()

    await handleIncomingMessage(session, 'otro intento', new AbortController().signal, {
      onDelta: vi.fn(),
      onQualification: vi.fn(),
      onLimitReached,
    })

    expect(onLimitReached).toHaveBeenCalledTimes(1)
    expect(streamAssistantReply).not.toHaveBeenCalled()
  })
})
