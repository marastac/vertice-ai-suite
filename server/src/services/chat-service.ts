import { sessionRepository } from '../repositories/session-repository.js'
import type { StoredSession } from '../repositories/session-repository.js'
import { recordUsageEvent } from '../repositories/usage-events-repository.js'
import { loadChatConfigurationForOrganization } from '../repositories/chat-config-repository.js'
import { chatQualificationResultSchema } from '../schemas/chat.js'
import type { ChatConfigurationInput, ChatQualificationResult } from '../schemas/chat.js'
import { aiProvider } from './ai-provider.js'
import { config } from '../config.js'
import { AppError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { resolveOrganizationIdForSlug } from './organization-lookup.js'
import { buildChatSystemPrompt, buildExtractionSystemPrompt } from './system-prompt.js'

type TrustedConfigOutcome =
  | { ok: true; config: ChatConfigurationInput }
  | { ok: false; reason: 'not_found' | 'unavailable' | 'inactive' }

/**
 * The ONE place that turns a `chat-config-repository.ts::ChatConfigLookup`
 * into a pass/fail verdict for spending Anthropic tokens — shared by
 * createSession() (session-creation time) and ensureConfigTrusted()
 * (per-message, for a session whose config was never validated yet), so
 * the "not_found vs unavailable vs inactive" decision only lives in one
 * place. Each caller still throws its OWN error type/message for each
 * `reason` (AppError with a status code at creation time; a plain Error
 * mid-conversation, mirroring ensureOrganizationResolved()'s own
 * not_found/unavailable message pattern) — this function only fetches and
 * classifies, it never decides how a failure should surface.
 */
async function resolveTrustedServerConfig(organizationId: string): Promise<TrustedConfigOutcome> {
  const lookup = await loadChatConfigurationForOrganization(organizationId)

  if (lookup.status === 'not_found') return { ok: false, reason: 'not_found' }
  if (lookup.status === 'unavailable') return { ok: false, reason: 'unavailable' }
  if (!lookup.config.isActive) return { ok: false, reason: 'inactive' }
  return { ok: true, config: lookup.config }
}

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
 * `config` from the request body is now OPTIONAL and, critically, is
 * ONLY EVER trusted for a `not_configured` organization (this backend has
 * no Supabase at all — see organization-lookup.ts) — the one case where
 * there is genuinely no other source of truth. For a `resolved`
 * organization, `config` is IGNORED COMPLETELY: the real
 * `chat_configuration` row is loaded server-side via
 * resolveTrustedServerConfig() and that is the only thing ever stored on
 * `StoredSession.config`/used to build an Anthropic prompt. This closes
 * the "orgSlug real + config inventado" gap identified in the read-only
 * audit — a client can no longer influence the system prompt, the
 * qualification criteria/scoring, or whether the chat is active, for any
 * real (Supabase-configured) organization.
 *
 * `unavailable` (a genuine but possibly transient organization-lookup
 * failure) still does NOT block session creation itself, same as before
 * this hardening — but its config is stored with NO configSource (left
 * `undefined`), since there is no trustworthy source yet either way. That
 * placeholder is never used to build a prompt: ensureConfigTrusted() (via
 * ensureOrganizationResolved() throwing first) guarantees this session can
 * never reach Anthropic until its organization — and therefore its config
 * — settles to something trustworthy.
 */
export async function createSession(orgSlug: string, config?: ChatConfigurationInput): Promise<StoredSession> {
  const organization = await resolveOrganizationIdForSlug(orgSlug)

  if (organization.status === 'not_found') {
    throw new AppError(404, 'Esta organización no existe o no está disponible.')
  }

  if (organization.status === 'resolved') {
    const outcome = await resolveTrustedServerConfig(organization.organizationId)
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') {
        throw new AppError(404, 'Esta organización todavía no tiene un chat configurado.')
      }
      if (outcome.reason === 'unavailable') {
        throw new AppError(503, 'No se pudo cargar la configuración del chat en este momento. Inténtalo de nuevo.')
      }
      throw new AppError(403, 'Este chat no está activo en este momento.')
    }
    return sessionRepository.create(orgSlug, outcome.config, organization, 'server')
  }

  if (organization.status === 'not_configured') {
    // The ONLY case where the client-supplied config is trusted — this
    // deployment has no Supabase at all, so there is no server-side
    // chat_configuration to load instead (see organization-lookup.ts's own
    // doc comment on what `not_configured` means).
    if (!config) {
      throw new AppError(400, 'Falta la configuración del chat.')
    }
    if (!config.isActive) {
      throw new AppError(403, 'Este chat no está activo en este momento.')
    }
    return sessionRepository.create(orgSlug, config, organization, 'local')
  }

  // organization.status === 'unavailable': session creation is still
  // allowed (unchanged from before this hardening — see
  // organization-lookup.ts/ensureOrganizationResolved()'s own reasoning for
  // why a transient outage must never refuse a real organization's
  // visitor), but there is no trustworthy config source yet. The client's
  // config is stored only as an immediate-response placeholder (for the
  // 201 response's welcomeMessage/assistantName) — configSource is
  // deliberately left undefined so ensureConfigTrusted() replaces it with
  // the real server config (or blocks) the moment this organization
  // resolves, before any Anthropic call.
  if (!config) {
    throw new AppError(400, 'Falta la configuración del chat.')
  }
  return sessionRepository.create(orgSlug, config, organization, undefined)
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

/**
 * Ensures `session.config` is TRUSTWORTHY before any Anthropic call — the
 * second half of the "never trust client config" hardening, and the
 * reason `organization.status === 'resolved'` alone is NOT enough for
 * streamAssistantReply()/extractQualification() to proceed (see
 * StoredSession.configSource's own doc comment for exactly why).
 *
 * MUST be called AFTER ensureOrganizationResolved() has already run and
 * NOT thrown — this function assumes `session.organization.status` is
 * either `'resolved'` or `'not_configured'` (the only two outcomes
 * ensureOrganizationResolved() ever lets through) and does not re-check
 * `'not_found'`/`'unavailable'` itself.
 *
 * `configSource === 'server'` or `'local'` is FINAL — this is a no-op for
 * both, by design (see the task's own explicit instruction: refreshing a
 * `'server'` config on every message, to catch an agency disabling the
 * chat minutes after a session started, would turn this hardening into a
 * per-message Supabase read; that trade-off is deliberately NOT made here
 * and is documented as a separate, accepted residual risk in the report).
 * `undefined` (an old on-disk session, or a session created while its
 * organization was still `'unavailable'` — see createSession()) is the
 * only case refreshed here, exactly once, before it's ever allowed to
 * settle.
 */
async function ensureConfigTrusted(session: StoredSession): Promise<void> {
  if (session.configSource === 'server' || session.configSource === 'local') {
    return
  }

  const organizationStatus = session.organization?.status

  if (organizationStatus === 'resolved') {
    const outcome = await resolveTrustedServerConfig(session.organization.organizationId)
    if (!outcome.ok) {
      throw new Error(
        outcome.reason === 'not_found'
          ? 'Esta organización todavía no tiene un chat configurado.'
          : outcome.reason === 'unavailable'
            ? 'No se pudo cargar la configuración del chat en este momento. Inténtalo de nuevo.'
            : 'Este chat no está activo en este momento.',
      )
    }
    sessionRepository.setConfig(session.id, outcome.config, 'server')
    session.config = outcome.config
    session.configSource = 'server'
    return
  }

  if (organizationStatus === 'not_configured') {
    // There is no server-side config to load — the existing session.config
    // (whatever the client sent at creation, or whatever an old
    // pre-hardening session already had) is exactly what 'not_configured'
    // allows trusting. Still re-verified against isActive here (an old
    // session's config may have been saved before this field was even
    // enforced consistently) before it's settled as final.
    if (!session.config.isActive) {
      throw new Error('Este chat no está activo en este momento.')
    }
    sessionRepository.setConfig(session.id, session.config, 'local')
    session.configSource = 'local'
    return
  }

  // Defensive only — ensureOrganizationResolved() (called immediately
  // before this, in handleIncomingMessage()) is expected to have already
  // thrown for anything other than 'resolved'/'not_configured', and to
  // have settled session.organization (via the shared session-repository
  // reference — see session-repository.ts) to reflect that before this
  // function ever runs. If this branch is ever reached anyway (e.g. a
  // future caller that skips that step, or a repository that doesn't share
  // references), the safe default is to BLOCK — never fall through to
  // spending Anthropic tokens on a config that was never validated.
  throw new Error('No se pudo verificar la configuración de esta conversación. Inténtalo de nuevo.')
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
 *
 * ensureConfigTrusted() runs THIRD, still before any call to Anthropic —
 * settling `organization` alone is not enough (see its own doc comment):
 * a session whose `config` was never validated against `chat_configuration`
 * is refreshed (or blocked) here, so streamAssistantReply()/
 * extractQualification() below can always assume `session.config` is
 * trustworthy by the time they run.
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
  await ensureConfigTrusted(session)

  for await (const delta of streamAssistantReply(session, userMessage, signal)) {
    handlers.onDelta(delta)
  }

  const qualification = await extractQualification(session, signal)
  handlers.onQualification(qualification)
}
