import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { logger as defaultLogger } from '../lib/logger.js'
import { quotaRepository } from '../repositories/quota-repository.js'
import type { QuotaDenyReason, QuotaMode, QuotaRepository, QuotaRpcResult, QuotaStatus } from '../repositories/quota-repository.js'

/**
 * Per-organization monthly quota gate. Wired into chat-service.ts behind the
 * global CHAT_QUOTAS_ENABLED flag (config.ts) — while that flag is off,
 * nothing in this file is ever called.
 *
 * The database (supabase/migrations-usage-quotas.sql) is the single source
 * of truth for every quota decision: limits, prices, counters and the
 * per-organization lock all live there. This service only:
 *   1. computes a conservative token upper bound for one chat message,
 *   2. asks the database to reserve it (idempotent by request id),
 *   3. turns the answer — or a FAILURE to get one — into proceed/block
 *      according to the organization's mode,
 *   4. settles the reservation with the real usage afterward.
 *
 * Nothing returned to a caller for the browser carries a reason code,
 * a price, a budget or an amount: a blocked visitor only ever gets one of
 * the two generic messages below.
 */

/**
 * Shown when the organization's quota refuses a conversation or message
 * (exhausted, suspended, not configured). Deliberately says nothing about
 * plans, limits, budgets, tokens or costs, and doesn't blame the visitor.
 */
export const QUOTA_UNAVAILABLE_MESSAGE =
  'Este asistente no está disponible en este momento. Gracias por tu interés; puedes contactar al equipo por sus otros canales de atención.'

/** Shown when availability could not be VERIFIED right now (database unreachable). Retryable; reveals no technical detail. */
export const QUOTA_TEMPORARY_ERROR_MESSAGE =
  'No pudimos conectar con el asistente en este momento. Inténtalo de nuevo en unos minutos.'

// ── Estimation ────────────────────────────────────────────────────────────

/**
 * Framing allowances added on top of the content bound below. Generous on
 * purpose (role markers, system/message wrappers, the extraction transcript's
 * "Visitante:"/"Asistente:" labels and its fixed instruction text). These
 * are an ASSUMPTION to be validated against real `usage_events` in shadow
 * mode (Fase 3), not a measured value.
 */
export const ESTIMATION_REQUEST_OVERHEAD_TOKENS = 128
export const ESTIMATION_MESSAGE_OVERHEAD_TOKENS = 16

export interface ChatMessageEstimateInput {
  /** Exactly what will be sent as the reply call's `system`. */
  replySystemPrompt: string
  /** Exactly the message contents the reply call will send, INCLUDING the new user message. */
  replyMessageContents: readonly string[]
  /** Exactly what will be sent as the extraction call's `system`. */
  extractionSystemPrompt: string
  /**
   * Exactly the extraction call's user message, built from the transcript
   * as it will be once the new user message is appended — but WITHOUT the
   * assistant reply, which doesn't exist yet. That reply is bounded by
   * `maxReplyTokens` instead.
   */
  extractionUserContentWithoutReply: string
  /** The reply call's `max_tokens` (ai-provider.ts MAX_REPLY_TOKENS). Passed in, never duplicated here, so the two can't drift. */
  maxReplyTokens: number
  /** The extraction call's `max_tokens` (ai-provider.ts MAX_EXTRACTION_TOKENS). */
  maxExtractionTokens: number
}

/** Upper bound for ONE call: input bound from bytes, output bound = its max_tokens. */
export interface CallTokenBound {
  inputTokens: number
  outputTokens: number
}

export interface ChatMessageEstimate {
  /** Sum of both calls' input bounds — what reserve_chat_usage() receives. */
  estimatedInputTokens: number
  /** Sum of both calls' max_tokens — what reserve_chat_usage() receives. */
  maxOutputTokens: number
  /** The same bounds split per call, so a settlement can keep the bound of only the call whose cost is unknown. */
  calls: { reply: CallTokenBound; extraction: CallTokenBound }
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function assertTokenLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

/**
 * Conservative UPPER BOUND for the two Anthropic calls one chat message
 * makes (reply + extraction). Pure — no I/O.
 *
 * Input bound: a token always encodes at least one byte, so a text's token
 * count never exceeds its UTF-8 byte length. Both calls are bounded that
 * way from the EXACT strings they will send, plus framing allowances. The
 * extraction call also re-reads the assistant reply produced by the first
 * call (unknown yet): bounded by the reply's own `max_tokens`, plus one
 * message allowance for its "Asistente: " label and any re-tokenization at
 * its boundaries.
 *
 * Output bound: exact — the sum of both calls' `max_tokens`, which the API
 * enforces as hard limits.
 *
 * This deliberately overestimates (Spanish text averages several bytes per
 * token); settlement replaces it with the real usage.
 */
export function estimateChatMessageUsage(input: ChatMessageEstimateInput): ChatMessageEstimate {
  assertTokenLimit('maxReplyTokens', input.maxReplyTokens)
  assertTokenLimit('maxExtractionTokens', input.maxExtractionTokens)

  const replyInput =
    ESTIMATION_REQUEST_OVERHEAD_TOKENS +
    utf8Bytes(input.replySystemPrompt) +
    input.replyMessageContents.reduce((sum, content) => sum + utf8Bytes(content), 0) +
    input.replyMessageContents.length * ESTIMATION_MESSAGE_OVERHEAD_TOKENS

  // One message (the transcript) plus one allowance for the reply inserted into it.
  const extractionInput =
    ESTIMATION_REQUEST_OVERHEAD_TOKENS +
    utf8Bytes(input.extractionSystemPrompt) +
    utf8Bytes(input.extractionUserContentWithoutReply) +
    input.maxReplyTokens +
    2 * ESTIMATION_MESSAGE_OVERHEAD_TOKENS

  return {
    estimatedInputTokens: replyInput + extractionInput,
    maxOutputTokens: input.maxReplyTokens + input.maxExtractionTokens,
    calls: {
      reply: { inputTokens: replyInput, outputTokens: input.maxReplyTokens },
      extraction: { inputTokens: extractionInput, outputTokens: input.maxExtractionTokens },
    },
  }
}

// ── Cost (mirror of SQL quota_cost_micros, for reporting/shadow analysis) ──

export interface ModelPrice {
  /** Micro-USD per MILLION input tokens — loaded from model_prices, never hard-coded. */
  inputMicrosPerMTok: bigint
  outputMicrosPerMTok: bigint
}

/**
 * Exact mirror of the SQL `quota_cost_micros()`: integer arithmetic, rounded
 * UP. The database remains authoritative for every quota decision — this
 * exists so shadow-mode analysis and tests use the identical formula. No
 * price is defined anywhere in code; callers supply one.
 */
export function computeCostMicros(inputTokens: number, outputTokens: number, price: ModelPrice): bigint {
  assertTokenLimit('inputTokens', inputTokens)
  assertTokenLimit('outputTokens', outputTokens)
  if (price.inputMicrosPerMTok < 0n || price.outputMicrosPerMTok < 0n) {
    throw new RangeError('prices must be non-negative')
  }
  const numerator = BigInt(inputTokens) * price.inputMicrosPerMTok + BigInt(outputTokens) * price.outputMicrosPerMTok
  return (numerator + 999_999n) / 1_000_000n
}

// ── Usage aggregation ─────────────────────────────────────────────────────

export interface CallUsage {
  inputTokens: number
  outputTokens: number
  /**
   * Prompt-cache tokens the API reported (ai-provider.ts). Always 0 today —
   * this project sends no cache_control. They're billed at their own rates
   * and are NOT included in inputTokens, so the quota's cost model (plain
   * input/output prices) would undercount them: see buildSettlementUsage().
   */
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  model: string
}

/** True when a completed call reported prompt-cache tokens the quota's cost model doesn't price. */
export function hasUnpricedCacheTokens(usage: CallUsage): boolean {
  return (usage.cacheCreationInputTokens ?? 0) > 0 || (usage.cacheReadInputTokens ?? 0) > 0
}

export interface SettledUsage {
  inputTokens: number
  outputTokens: number
  /** Model to price the tokens with; null = the reservation's own model/prices. */
  model: string | null
}

/**
 * What happened to ONE Anthropic call of a message:
 *   completed         — the API returned a final message with its real usage.
 *   rejected_unbilled — the API answered with an HTTP error confirmed to carry
 *                       no billable usage (ai-provider.ts::isConfirmedUnbilledRejection).
 *   unknown           — failed/aborted/timed out/errored mid-stream: real usage
 *                       can't be known, so that call keeps its upper bound.
 * A call that was never made has no outcome at all (counted as zero).
 */
export type CallOutcome =
  | { status: 'completed'; usage: CallUsage }
  | { status: 'rejected_unbilled' }
  | { status: 'unknown' }

export interface MessageCallOutcomes {
  reply?: CallOutcome
  extraction?: CallOutcome
}

/**
 * Builds what to settle for one message from each call's outcome, per call:
 *   completed → its real tokens · rejected_unbilled or never made → 0 ·
 *   unknown → that call's own upper bound (never the other call's).
 * So a completed reply keeps its exact usage even if the extraction failed,
 * and a reply rejected before starting settles at zero (the extraction is
 * never made after a failed reply).
 *
 * Returns null — "keep the whole reservation estimate", the most
 * conservative settlement — when there's no reply outcome at all (the
 * message ended before its first call was even attempted or classified),
 * or when completed calls report different models (can't be priced as one).
 *
 * A completed call that reports prompt-cache tokens is settled like an
 * UNKNOWN one (its own upper bound) and logged: its real cost can't be
 * computed from plain input/output prices, and counting only inputTokens
 * would undercount. Never happens today (no cache_control is sent); it
 * guards against enabling caching without extending the cost model.
 */
export function buildSettlementUsage(estimate: ChatMessageEstimate, outcomes: MessageCallOutcomes): SettledUsage | null {
  if (!outcomes.reply) return null

  let inputTokens = 0
  let outputTokens = 0
  const models = new Set<string>()

  const add = (outcome: CallOutcome | undefined, bound: CallTokenBound) => {
    if (!outcome || outcome.status === 'rejected_unbilled') return
    if (outcome.status === 'completed' && hasUnpricedCacheTokens(outcome.usage)) {
      defaultLogger.warn('Quota: a call reported prompt-cache tokens the cost model does not price — settling it at its upper bound', {
        model: outcome.usage.model,
        cacheCreationInputTokens: outcome.usage.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: outcome.usage.cacheReadInputTokens ?? 0,
      })
      inputTokens += bound.inputTokens
      outputTokens += bound.outputTokens
      return
    }
    if (outcome.status === 'completed') {
      inputTokens += outcome.usage.inputTokens
      outputTokens += outcome.usage.outputTokens
      models.add(outcome.usage.model)
      return
    }
    inputTokens += bound.inputTokens
    outputTokens += bound.outputTokens
  }

  add(outcomes.reply, estimate.calls.reply)
  add(outcomes.extraction, estimate.calls.extraction)

  if (models.size > 1) return null
  // A bound (unknown call) is priced with the reservation's own snapshot
  // prices; real usage uses the model the API reported. When both are mixed,
  // the reported model prices everything — the same model in practice.
  return { inputTokens, outputTokens, model: models.size === 1 ? [...models][0] : null }
}

// ── Gate ──────────────────────────────────────────────────────────────────

export type QuotaBlockReason = QuotaDenyReason | 'verification_failed'

export type QuotaDecision =
  | {
      proceed: true
      mode: QuotaMode
      /** Present only when the database actually recorded a reservation ('shadow'/'enforce'). Pass it to settle(). */
      reservationId: string | null
    }
  | {
      proceed: false
      /** Server-side only — for logs/metrics. Never send to the browser. */
      reason: QuotaBlockReason
      /** Safe, generic text for the visitor — see QUOTA_UNAVAILABLE_MESSAGE / QUOTA_TEMPORARY_ERROR_MESSAGE. */
      publicMessage: string
    }

export interface ReserveMessageInput {
  /**
   * One id per incoming HTTP message, generated with newQuotaRequestId().
   * Reused for this service's own internal retry of the same RPC — that is
   * the ONLY retry it deduplicates (see withOneRetry()). A browser re-sending
   * a message is a new HTTP request, gets a new id, and is metered as the new
   * Anthropic calls it actually triggers.
   */
  requestId: string
  organizationId: string
  sessionId: string
  model: string
  estimate: ChatMessageEstimate
}

export interface QuotaServiceOptions {
  repository?: QuotaRepository
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>
  /** The model the chat calls Anthropic with. Defaults to config.anthropicModel (ANTHROPIC_MODEL). */
  model?: () => string
}

export interface QuotaService {
  reserveForMessage(input: ReserveMessageInput): Promise<QuotaDecision>
  settle(reservationId: string | null, usage: SettledUsage | null): Promise<{ settled: boolean }>
  /**
   * Read-only pre-check before a NEW conversation is created. Never writes,
   * never counts a conversation, never reserves budget — it only avoids
   * opening a chat that could not answer its first message. The atomic
   * per-message reservation stays the only real guarantee (two sessions can
   * both pass this check; only what fits in the budget will reserve).
   */
  checkNewConversation(organizationId: string): Promise<QuotaDecision>
}

export function newQuotaRequestId(): string {
  return randomUUID()
}

/**
 * Pure decision for checkNewConversation(), mirroring the order and rules of
 * the SQL reserve_chat_usage(): no quota row → suspended → limits not
 * configured → conversations exhausted → budget exhausted. Budget is
 * "exhausted" here only when NOTHING is left (settled + reserved ≥ budget):
 * a small remainder may still not fit the first message's estimate, which
 * reserve decides exactly. Returns null when a new conversation may start.
 */
export function evaluateNewConversation(status: QuotaStatus): QuotaDenyReason | null {
  if (status.mode === 'unconfigured') return 'quota_not_configured'
  // Same position as in reserve_chat_usage() (right after the mode): with no
  // price for the configured model every message would be denied anyway.
  // Only present when the status was requested WITH a model.
  if (status.model_price_configured === false) return 'model_price_missing'
  if (status.status === 'suspended') return 'suspended'
  if (status.conversation_limit === null || status.budget_micros === null) return 'limit_not_configured'
  if (status.conversations_used >= status.conversation_limit) return 'conversation_limit_reached'
  if (status.settled_micros + status.reserved_micros >= status.budget_micros) return 'budget_exhausted'
  return null
}

async function withOneRetry<T>(call: () => Promise<QuotaRpcResult<T>>): Promise<QuotaRpcResult<T>> {
  const first = await call()
  // Only transient failures are retried, and always with the SAME arguments
  // (same request id / reservation id): both RPCs are idempotent in the
  // database, so a first attempt that actually committed is returned as a
  // replay instead of being applied twice.
  if (first.ok || first.kind !== 'transient') return first
  return call()
}

/**
 * FAILURE POLICY (definitive, Fase 4). While CHAT_QUOTAS_ENABLED is on, an
 * AI call happens only if the database CONFIRMED it in this very request.
 * If the database gives no usable answer (timeout, network, error,
 * unexpected shape) the call is blocked — for every organization and every
 * mode, with no exceptions and no remembered state. Rationale: the mode
 * itself lives in that database, so any fallback would have to trust a
 * possibly stale copy of it, which is exactly how an organization that just
 * moved to 'enforce' could keep consuming unverified. The visitor gets a
 * calm, retryable message; nothing is charged; Anthropic is never called.
 * (While the flag is off, none of this code runs at all.)
 */
export function createQuotaService(options: QuotaServiceOptions = {}): QuotaService {
  const repository = options.repository ?? quotaRepository
  const log = options.logger ?? defaultLogger
  const model = options.model ?? (() => config.anthropicModel)

  function denied(reason: QuotaDenyReason): QuotaDecision {
    return { proceed: false, reason, publicMessage: QUOTA_UNAVAILABLE_MESSAGE }
  }

  function unverified(): QuotaDecision {
    return { proceed: false, reason: 'verification_failed', publicMessage: QUOTA_TEMPORARY_ERROR_MESSAGE }
  }

  return {
    async reserveForMessage(input) {
      const result = await withOneRetry(() =>
        repository.reserve({
          requestId: input.requestId,
          organizationId: input.organizationId,
          sessionId: input.sessionId,
          model: input.model,
          estimatedInputTokens: input.estimate.estimatedInputTokens,
          maxOutputTokens: input.estimate.maxOutputTokens,
        }),
      )

      if (!result.ok) {
        log.error('Quota verification failed — blocking AI call (fail closed)', {
          organizationId: input.organizationId,
          sessionId: input.sessionId,
          kind: result.kind,
          message: result.message,
        })
        return unverified()
      }

      const { data } = result
      // No quota row = never unlimited, whatever `allowed` says (an older
      // SQL version answered allowed=true here). Only an EXPLICIT 'off' row
      // lets an organization through without metering.
      if (data.mode === 'unconfigured') {
        log.warn('Quota blocked an AI call: organization has no quota configuration', {
          organizationId: input.organizationId,
          sessionId: input.sessionId,
        })
        return denied('quota_not_configured')
      }

      if (!data.allowed) {
        log.warn('Quota blocked an AI call', {
          organizationId: input.organizationId,
          sessionId: input.sessionId,
          reason: data.reason,
        })
        // The repository schema guarantees a reason on every denial.
        return data.reason ? denied(data.reason) : unverified()
      }

      if (data.mode === 'shadow' && data.reason) {
        // 'model_price_missing' in shadow means NOTHING is being recorded for
        // this model — a silent gap in the shadow data, so it's a warning.
        const logShadow = data.reason === 'model_price_missing' ? log.warn : log.info
        logShadow('Quota shadow mode: this call would have been blocked under enforce', {
          organizationId: input.organizationId,
          sessionId: input.sessionId,
          reason: data.reason,
        })
      }

      return { proceed: true, mode: data.mode, reservationId: data.reservationId }
    },

    async settle(reservationId, usage) {
      if (!reservationId) return { settled: false }

      const result = await withOneRetry(() =>
        repository.settle({
          reservationId,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          model: usage?.model ?? null,
        }),
      )

      if (result.ok) {
        // A settlement arriving after expire_stale_chat_reservations() already
        // closed this reservation at its full estimate: nothing changes (no
        // double charge, no downward correction). Logged because it means a
        // message outlived the expiry window — revisit RESERVATION_EXPIRY_MINUTES.
        if (result.data.replayed && result.data.basis === 'expired') {
          log.warn('Late quota settlement: the reservation had already expired at its full estimate', { reservationId })
        }
        return { settled: true }
      }

      // Never throws into the chat: the visitor already got their reply. The
      // reservation simply stays counted at its (higher) estimate in the
      // database, which is the safe direction for the budget.
      log.warn('Quota settlement failed — reservation stays counted at its estimate', {
        reservationId,
        kind: result.kind,
        message: result.message,
      })
      return { settled: false }
    },

    async checkNewConversation(organizationId) {
      // With the configured model, so a missing price is caught BEFORE opening
      // a conversation whose first message would be denied under enforce.
      const result = await withOneRetry(() => repository.getStatus(organizationId, model()))

      if (!result.ok) {
        log.error('Quota status unavailable — refusing to open a new conversation (fail closed)', {
          organizationId,
          kind: result.kind,
          message: result.message,
        })
        return unverified()
      }

      const status = result.data
      const reason = evaluateNewConversation(status)

      // 'unconfigured' (no quota row) is refused like 'enforce' — never unlimited.
      if (reason && (status.mode === 'enforce' || status.mode === 'unconfigured')) {
        log.warn('Quota refused a new conversation', { organizationId, reason })
        return denied(reason)
      }
      if (reason && status.mode === 'shadow') {
        // A missing price is a configuration problem shadow mode would hide
        // (it records nothing for that model) — warn, don't just inform.
        const logShadow = reason === 'model_price_missing' ? log.warn : log.info
        logShadow('Quota shadow mode: this new conversation would have been refused under enforce', { organizationId, reason, model: model() })
      }
      return { proceed: true, mode: status.mode, reservationId: null }
    },
  }
}

export const quotaService: QuotaService = createQuotaService()
