import { sessionRepository } from '../repositories/session-repository.js'
import type { StoredSession } from '../repositories/session-repository.js'
import { recordUsageEvent } from '../repositories/usage-events-repository.js'
import { chatQualificationResultSchema } from '../schemas/chat.js'
import type { ChatConfigurationInput, ChatQualificationResult } from '../schemas/chat.js'
import { aiProvider } from './ai-provider.js'
import { config } from '../config.js'
import { AppError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { resolveOrganizationIdForSlug } from './organization-lookup.js'
import { buildChatSystemPrompt, buildExtractionSystemPrompt } from './system-prompt.js'

/**
 * Attempts the session's organization resolution once, at creation time,
 * and — unlike an earlier version of this function — REJECTS session
 * creation outright when that resolution comes back `not_found`: Supabase
 * is configured for this deployment, the query worked, and no
 * `organizations` row matches this slug. There is no cleaner or more
 * useful thing this session could ever do afterward (it can only ever be
 * blocked later, on its first message, by ensureOrganizationResolved()
 * below), so rejecting here — a plain 404 via the same AppError path
 * routes/chat.ts already uses for "session not found"/"chat not
 * configured" — is strictly better for the visitor (an immediate, honest
 * response instead of a session that quietly can never do anything) and
 * costs nothing to implement, since createSession() already awaits this
 * resolution unconditionally.
 *
 * `not_configured` (the permitted local/dev case — this deployment has no
 * Supabase credential at all, see organization-lookup.ts) and `resolved`
 * both still create the session exactly as before. `unavailable` (a
 * genuine but possibly transient lookup failure) is ALSO still stored
 * as-is rather than rejected — rejecting session creation for a transient
 * outage would refuse even visitors of organizations that really do exist,
 * which a confirmed `not_found` never risks. ensureOrganizationResolved()
 * gives an `unavailable` session a fresh chance to resolve on its first
 * message, before any call to Anthropic.
 */
export async function createSession(orgSlug: string, config: ChatConfigurationInput): Promise<StoredSession> {
  const organization = await resolveOrganizationIdForSlug(orgSlug)

  if (organization.status === 'not_found') {
    throw new AppError(404, 'Esta organización no existe o no está disponible.')
  }

  return sessionRepository.create(orgSlug, config, organization)
}

/**
 * Ensures this session's organization attribution is settled to a state
 * that's safe to spend Anthropic tokens on (`resolved` or `not_configured`
 * — see organization-lookup.ts::OrganizationResolution for exactly what
 * each means and why they're kept distinct) before the caller ever reaches
 * streamAssistantReply()/extractQualification().
 *
 * `resolved`, `not_configured`, AND `not_found` are all treated as FINAL
 * here — never re-attempted again for this session. The first two are
 * final because proceeding is always correct for them; `not_found` is
 * final for the opposite reason: it's a CONFIRMED absence (see
 * organization-lookup.ts's own doc comment), not a wobble that deserves a
 * retry on every single message of the conversation — but being final
 * does NOT mean safe: it still blocks every message, forever, for this
 * session. (In practice createSession() above already rejects `not_found`
 * before a session can even be created — this branch exists for
 * completeness, and for the one path createSession() can't cover: an old
 * on-disk session created before that check existed.)
 *
 * `undefined` (a session from before this field existed at all) and
 * `'unavailable'` (a previous attempt — at creation or on an earlier
 * message — genuinely failed, and is explicitly NOT final, per
 * organization-lookup.ts) are treated identically: worth a fresh attempt
 * right now, before spending any new tokens. A resolution reached here is
 * persisted via sessionRepository.setOrganization() so later messages in
 * the same conversation never re-attempt it once settled to something
 * final.
 *
 * Throws when the settled status is `not_found` or `unavailable` — the
 * caller (handleIncomingMessage) must never proceed to
 * streamAssistantReply() afterward. This is deliberately a plain throw,
 * not a new SSE event: routes/chat.ts's existing catch block already turns
 * any thrown error here into the same calm, generic, retryable `error` SSE
 * event it already sends for any other mid-stream failure — no new
 * frontend handling needed, and no internal detail (which of the two blocking
 * reasons it was) is ever exposed past that generic client-facing message.
 */
async function ensureOrganizationResolved(session: StoredSession): Promise<void> {
  let organization = session.organization

  if (organization?.status === undefined || organization.status === 'unavailable') {
    organization = await resolveOrganizationIdForSlug(session.orgSlug)
    sessionRepository.setOrganization(session.id, organization)
  }

  if (organization.status === 'not_found' || organization.status === 'unavailable') {
    throw new Error(
      organization.status === 'not_found'
        ? 'Esta organización no existe o no está disponible.'
        : 'No se pudo verificar la organización de esta conversación (fallo temporal). Inténtalo de nuevo.',
    )
  }
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

/**
 * Streams the assistant's reply as text deltas, then appends the full turn
 * to session history. Also records a `purpose: 'reply'` usage event with
 * the REAL usage/model aiProvider.streamAssistantReply() reports — see
 * ai-provider.ts's AssistantReplyResult. If the underlying call throws
 * (aborted, network error, etc.) this generator throws too, before ever
 * reaching the return value below — no usage event is recorded for a call
 * that didn't actually complete, and nothing here invents one.
 *
 * Usage recording is `await`ed (never fire-and-forget) — see
 * usage-events-repository.ts::recordUsageEvent()'s own contract: it NEVER
 * throws, under any failure mode (Supabase not configured, network error,
 * insert error), so awaiting it adds no risk of breaking the reply the
 * visitor already received in full via streaming; it only makes this step
 * wait for the persistence ATTEMPT to settle (success or safely-logged
 * failure) before this function itself completes, closing the window where
 * a process restart between "Anthropic responded" and "the write finished"
 * could silently drop the event.
 */
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
  const result = next.value
  fullText = result.text || fullText

  sessionRepository.appendTurn(session.id, { role: 'assistant', content: fullText })

  // Optional-chained defensively — by the time handleIncomingMessage()
  // reaches here, ensureOrganizationResolved() has already settled
  // session.organization to 'resolved'/'not_found', but this never assumes
  // that invariant: an old on-disk session (or a future caller that skips
  // that step) simply skips metering instead of crashing.
  if (result.usage && session.organization?.status === 'resolved') {
    await recordUsageEvent({
      organizationId: session.organization.organizationId,
      sessionId: session.id,
      purpose: 'reply',
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    })
  }
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
 *
 * Usage recording is deliberately split from parsing: a `purpose:
 * 'extraction'` usage event is recorded as soon as the Anthropic call
 * itself succeeds — BEFORE attempting JSON.parse/Zod validation — so a
 * response that came back real (and cost real tokens) but later turns out
 * to be malformed/unparseable still gets its usage recorded. If the call
 * itself throws (aborted, network error, etc.), no usage event is recorded
 * at all — nothing here invents a value for a call that didn't complete.
 */
export async function extractQualification(session: StoredSession, signal: AbortSignal): Promise<ChatQualificationResult | null> {
  if (session.history.length === 0) return null

  let raw: string
  try {
    const result = await aiProvider.extractStructuredText({
      systemPrompt: buildExtractionSystemPrompt(session.config),
      transcript: renderTranscript(session),
      signal,
    })
    raw = result.text

    if (result.usage && session.organization?.status === 'resolved') {
      await recordUsageEvent({
        organizationId: session.organization.organizationId,
        sessionId: session.id,
        purpose: 'extraction',
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      })
    }
  } catch (error) {
    logger.warn('Qualification extraction failed', {
      sessionId: session.id,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  try {
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
 *
 * ensureOrganizationResolved() runs SECOND, still before any call to
 * Anthropic — if this session's organization is still genuinely unresolved
 * after a fresh attempt (Supabase configured but temporarily unreachable),
 * it throws and this function propagates that throw: no call to Anthropic,
 * no turn appended to history, no qualification touched. The route's
 * existing catch block turns this into the same calm, generic, retryable
 * `error` SSE event it already sends for any other mid-stream failure.
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

  await ensureOrganizationResolved(session)

  for await (const delta of streamAssistantReply(session, userMessage, signal)) {
    handlers.onDelta(delta)
  }

  const qualification = await extractQualification(session, signal)
  handlers.onQualification(qualification)
}
