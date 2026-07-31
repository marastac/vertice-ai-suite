import { sessionRepository } from '../repositories/session-repository.js'
import type { StoredSession } from '../repositories/session-repository.js'
import { chatQualificationResultSchema } from '../schemas/chat.js'
import type { ChatConfigurationInput, ChatQualificationResult } from '../schemas/chat.js'
import { aiProvider } from './ai-provider.js'
import { logger } from '../lib/logger.js'
import { buildChatSystemPrompt, buildExtractionSystemPrompt } from './system-prompt.js'

export function createSession(orgSlug: string, config: ChatConfigurationInput): StoredSession {
  return sessionRepository.create(orgSlug, config)
}

export function getSession(sessionId: string): StoredSession | undefined {
  return sessionRepository.get(sessionId)
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
