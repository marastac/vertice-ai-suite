import { sessionRepository } from '../repositories/session-repository.js'
import type { StoredSession } from '../repositories/session-repository.js'
import { chatQualificationResultSchema } from '../schemas/chat.js'
import type { ChatConfigurationInput, ChatQualificationResult } from '../schemas/chat.js'
import { aiProvider } from './ai-provider.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { buildChatSystemPrompt, buildExtractionSystemPrompt } from './system-prompt.js'

export function createSession(orgSlug: string, config: ChatConfigurationInput): StoredSession {
  return sessionRepository.create(orgSlug, config)
}

export function getSession(sessionId: string): StoredSession | undefined {
  return sessionRepository.get(sessionId)
}

/**
 * Technical protection against a runaway conversation, NOT a commercial
 * plan limit — global for every organization, no per-org configuration
 * yet (see config.ts::chatMaxUserMessagesPerConversation). Counts ONLY
 * `role: 'user'` turns already in `session.history` — the real, persisted
 * history is the sole source of truth; nothing from the request body (a
 * client-supplied counter) is ever trusted. Assistant turns never count
 * toward this limit.
 *
 * Callers MUST check this BEFORE calling streamAssistantReply() — that
 * function's very first action is appending the new user turn to history,
 * before it ever calls Anthropic, so checking any later than this would
 * both store a message meant to be rejected AND still spend a call.
 *
 * A pre-existing session created before this limit existed needs no
 * migration or backfill: the count is computed live from history already
 * on file, so it's simply blocked the next time it's checked once it's
 * at or over the threshold.
 */
export function hasReachedMessageLimit(session: StoredSession): boolean {
  const userMessageCount = session.history.filter((turn) => turn.role === 'user').length
  return userMessageCount >= config.chatMaxUserMessagesPerConversation
}

/** Streams the assistant's reply as text deltas, then appends the full turn to session history. */
export async function* streamAssistantReply(
  session: StoredSession,
  userMessage: string,
  signal: AbortSignal,
): AsyncGenerator<string, void, void> {
  sessionRepository.appendTurn(session.id, { role: 'user', content: userMessage })

  const systemPrompt = buildChatSystemPrompt(session.config)
  const generator = aiProvider.streamAssistantReply({
    systemPrompt,
    history: session.history,
    signal,
  })

  let fullText = ''
  let next = await generator.next()
  while (!next.done) {
    fullText += next.value
    yield next.value
    next = await generator.next()
  }
  fullText = next.value || fullText

  sessionRepository.appendTurn(session.id, { role: 'assistant', content: fullText })
}

function renderTranscript(session: StoredSession): string {
  return session.history
    .map((turn) => `${turn.role === 'user' ? 'Visitante' : 'Asistente'}: ${turn.content}`)
    .join('\n')
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  return fenced ? fenced[1] : trimmed
}

/**
 * Asks the model for a structured qualification result and validates it with
 * Zod before trusting any of it. Returns null if the model's output can't be
 * parsed as a valid result — callers should treat that as "not enough
 * information yet", not as an error.
 */
export async function extractQualification(session: StoredSession, signal: AbortSignal): Promise<ChatQualificationResult | null> {
  if (session.history.length === 0) return null

  try {
    const raw = await aiProvider.extractStructuredText({
      systemPrompt: buildExtractionSystemPrompt(session.config),
      transcript: renderTranscript(session),
      signal,
    })

    const parsed = JSON.parse(stripJsonFences(raw))
    const result = chatQualificationResultSchema.safeParse(parsed)

    if (!result.success) {
      logger.warn('Qualification extraction failed Zod validation', { sessionId: session.id })
      return null
    }

    sessionRepository.setQualification(session.id, result.data)
    return result.data
  } catch (error) {
    logger.warn('Qualification extraction failed', {
      sessionId: session.id,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** Ready-to-display, calm closing text — never a raw error, never technical wording. Exported only so tests can assert against the exact string without duplicating it. */
export const CONVERSATION_LIMIT_MESSAGE =
  'Esta conversación alcanzó su límite de mensajes. Gracias por tu tiempo — el equipo dará seguimiento pronto.'

export interface IncomingMessageHandlers {
  onDelta: (text: string) => void
  onQualification: (qualification: ChatQualificationResult | null) => void
  onLimitReached: (message: string) => void
}

/**
 * Orchestrates one incoming chat message end-to-end: the message-limit
 * check, the streamed reply, and the qualification extraction. Extracted
 * from the route handler specifically so this decision logic is testable
 * without an HTTP harness (this project has none) — same reasoning as
 * routes/hubspot.ts's handleOauthCallback()/disconnectHubspotConnection().
 * The route itself only wires these callbacks to SSE `sendEvent` calls and
 * never re-implements this ordering.
 *
 * The limit check runs FIRST, before anything else — see
 * hasReachedMessageLimit()'s doc comment for why it must never run any
 * later than this. When it trips: `onLimitReached` fires and the function
 * returns immediately — streamAssistantReply() (the only thing that calls
 * Anthropic or appends to history) and extractQualification() (the only
 * thing that changes the stored qualification) are never reached.
 */
export async function handleIncomingMessage(
  session: StoredSession,
  userMessage: string,
  signal: AbortSignal,
  handlers: IncomingMessageHandlers,
): Promise<void> {
  if (hasReachedMessageLimit(session)) {
    handlers.onLimitReached(CONVERSATION_LIMIT_MESSAGE)
    return
  }

  for await (const delta of streamAssistantReply(session, userMessage, signal)) {
    handlers.onDelta(delta)
  }

  const qualification = await extractQualification(session, signal)
  handlers.onQualification(qualification)
}
