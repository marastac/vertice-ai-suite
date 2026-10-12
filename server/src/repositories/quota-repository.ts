import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase-client.js'

/**
 * Thin, typed access to the three quota RPCs created by
 * supabase/migrations-usage-quotas.sql (Fase 1): reserve_chat_usage,
 * settle_chat_usage, get_organization_quota_status. All quota DECISIONS
 * live in Postgres (atomic, per-organization row lock) — this file never
 * decides anything, it only calls, times out, and validates.
 *
 * NEVER throws: every failure (Supabase not configured, network error,
 * PostgREST/Postgres error, timeout, unexpected response shape) comes back
 * as a typed `{ ok: false }` result, so quota-service.ts is the single
 * place that decides whether a failure blocks AI usage (enforce) or is only
 * logged (shadow). Error `message`s are server-side only — they must never
 * be forwarded to a browser.
 *
 * Writes via `supabaseAdmin` (service_role) — the only role the Fase 1
 * migration grants EXECUTE on these functions to.
 */

/** Per-call timeout. Short on purpose: reserve runs before every AI call, on the visitor's critical path. */
export const QUOTA_RPC_TIMEOUT_MS = 3_000

export const quotaModeSchema = z.enum(['unconfigured', 'off', 'shadow', 'enforce'])
export type QuotaMode = z.infer<typeof quotaModeSchema>

export const quotaDenyReasonSchema = z.enum([
  'suspended',
  'limit_not_configured',
  'hourly_cap_reached',
  'conversation_limit_reached',
  'budget_exhausted',
  'model_price_missing',
  // Organization with no organization_quotas row ('unconfigured'): never unlimited.
  'quota_not_configured',
])
export type QuotaDenyReason = z.infer<typeof quotaDenyReasonSchema>

const micros = z.number().int().nonnegative()

const reserveResultSchema = z
  .object({
    allowed: z.boolean(),
    mode: quotaModeSchema,
    reservation_id: z.uuid().nullable(),
    reason: quotaDenyReasonSchema.nullable(),
    replayed: z.boolean(),
  })
  // Internal consistency with the SQL contract — anything else is treated as
  // an unexpected response (and therefore fails closed under enforce):
  // only 'enforce' or 'unconfigured' (no quota row) can deny, a denial
  // always carries a reason, and an allowed 'enforce' call always carries
  // the reservation it created. An ALLOWED 'unconfigured' answer (the SQL
  // before the no-row fix) still parses — quota-service.ts denies it anyway.
  .refine(
    (r) => r.allowed || ((r.mode === 'enforce' || r.mode === 'unconfigured') && r.reason !== null && r.reservation_id === null),
  )
  .refine((r) => !(r.allowed && r.mode === 'enforce') || r.reservation_id !== null)

// 'expired' only ever comes back as a REPLAY: a late settlement of a
// reservation that expire_stale_chat_reservations() already closed.
const settlementBasisSchema = z.enum(['actual', 'estimated', 'reservation_price', 'expired'])

const settleResultSchema = z.object({
  reservation_id: z.uuid(),
  actual_micros: micros,
  basis: settlementBasisSchema,
  replayed: z.boolean(),
})

const expireResultSchema = z.object({
  expired_count: z.number().int().nonnegative(),
  expired_micros: micros,
  organizations_processed: z.number().int().nonnegative(),
  organizations_skipped_locked: z.number().int().nonnegative(),
  organizations_failed: z.number().int().nonnegative(),
})

// Present only when getStatus() was called WITH a model: whether
// model_prices has a row for that exact identifier.
const modelPriceConfigured = z.boolean().optional()

const statusResultSchema = z.union([
  z.object({ mode: z.literal('unconfigured'), period_start: z.string(), model_price_configured: modelPriceConfigured }),
  z.object({
    mode: z.enum(['off', 'shadow', 'enforce']),
    status: z.enum(['active', 'suspended']),
    plan_code: z.string().nullable(),
    period_start: z.string(),
    conversation_limit: z.number().int().nonnegative().nullable(),
    budget_micros: micros.nullable(),
    hourly_message_cap: z.number().int().positive().nullable(),
    conversations_used: z.number().int().nonnegative(),
    messages_used: z.number().int().nonnegative(),
    reserved_micros: micros,
    settled_micros: micros,
    model_price_configured: modelPriceConfigured,
  }),
])

export interface ReserveInput {
  requestId: string
  organizationId: string
  sessionId: string
  model: string
  estimatedInputTokens: number
  maxOutputTokens: number
}

export interface ReserveResult {
  allowed: boolean
  mode: QuotaMode
  reservationId: string | null
  reason: QuotaDenyReason | null
  replayed: boolean
}

export interface SettleInput {
  reservationId: string
  /** Both null = real usage unknown (failed/aborted call) → the database keeps the estimate. */
  inputTokens: number | null
  outputTokens: number | null
  model: string | null
}

export interface SettleResult {
  reservationId: string
  actualMicros: number
  basis: z.infer<typeof settlementBasisSchema>
  replayed: boolean
}

/**
 * Minimum age, in minutes, before an open reservation counts as abandoned.
 * The SQL function enforces the same floor. Must stay far above the longest
 * legitimate reservation lifetime (~70 s today: REQUEST_TIMEOUT_MS = 45 s in
 * routes/chat.ts, plus the quota RPC and usage_events timeouts). If any of
 * those grow, revisit this — see DISENO_RIESGO_2.txt.
 */
export const RESERVATION_EXPIRY_MINUTES = 15

/** Per-call timeout for the sweep: it may touch many organizations, and it is off the visitor's critical path. */
export const QUOTA_EXPIRE_RPC_TIMEOUT_MS = 15_000

export interface ExpireResult {
  expiredCount: number
  expiredMicros: number
  organizationsProcessed: number
  organizationsSkippedLocked: number
  organizationsFailed: number
}

export type QuotaStatus = z.infer<typeof statusResultSchema>

/**
 * `transient` failures (timeout, network, unreachable) are safe to retry
 * with the SAME request id — reserve/settle are idempotent in the database.
 * `rejected` means Postgres itself refused the call (invalid argument,
 * request-id conflict, missing reservation) — retrying can't help.
 */
export type QuotaFailureKind = 'not_configured' | 'transient' | 'rejected' | 'invalid_response'

export type QuotaRpcResult<T> = { ok: true; data: T } | { ok: false; kind: QuotaFailureKind; message: string }

/** Error codes raised by the Fase 1 SQL functions (`raise exception '...'`). */
const KNOWN_SQL_ERRORS = [
  'QUOTA_INVALID_ARGUMENT',
  'QUOTA_REQUEST_ID_CONFLICT',
  'QUOTA_RESERVATION_NOT_FOUND',
  'QUOTA_PERIOD_NOT_FOUND',
] as const

function classifyError(error: { message?: string; code?: string } | null | undefined): QuotaFailureKind {
  const message = error?.message ?? ''
  if (KNOWN_SQL_ERRORS.some((code) => message.includes(code))) return 'rejected'
  // P0001 = raise_exception, 42501 = insufficient_privilege, 42883 = function
  // does not exist (migration not applied), class 22 = data exception (e.g.
  // a malformed uuid), PGRST* = PostgREST request errors. None of these get
  // better by retrying.
  const code = error?.code
  if (code && (code === 'P0001' || code === '42501' || code === '42883' || code.startsWith('22') || code.startsWith('PGRST'))) {
    return 'rejected'
  }
  return 'transient'
}

async function callRpc<T>(
  fn: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
  timeoutMs: number = QUOTA_RPC_TIMEOUT_MS,
): Promise<QuotaRpcResult<T>> {
  if (!supabaseAdmin) {
    return { ok: false, kind: 'not_configured', message: 'Supabase is not configured on this backend.' }
  }

  try {
    const { data, error } = await supabaseAdmin
      .rpc(fn, args)
      .abortSignal(AbortSignal.timeout(timeoutMs))

    if (error) {
      return { ok: false, kind: classifyError(error), message: error.message ?? 'Unknown RPC error' }
    }

    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      return { ok: false, kind: 'invalid_response', message: `Unexpected ${fn} response shape` }
    }
    return { ok: true, data: parsed.data }
  } catch (error) {
    // A thrown abort/timeout or network failure — the call may or may not
    // have committed server-side, which is exactly why retries reuse the
    // same request id.
    return { ok: false, kind: 'transient', message: error instanceof Error ? error.message : String(error) }
  }
}

export interface QuotaRepository {
  reserve(input: ReserveInput): Promise<QuotaRpcResult<ReserveResult>>
  settle(input: SettleInput): Promise<QuotaRpcResult<SettleResult>>
  /** With `model`, the answer also says whether that exact model has a price (`model_price_configured`). */
  getStatus(organizationId: string, model?: string): Promise<QuotaRpcResult<QuotaStatus>>
  /** Read-only: does model_prices have a row for this exact identifier? Used by the startup check. Never throws. */
  hasModelPrice(model: string): Promise<QuotaRpcResult<boolean>>
  /** Closes abandoned reservations at their full estimate (expire_stale_chat_reservations). Idempotent; never frees anything. */
  expireStale(): Promise<QuotaRpcResult<ExpireResult>>
}

export const quotaRepository: QuotaRepository = {
  async reserve(input) {
    const result = await callRpc(
      'reserve_chat_usage',
      {
        p_request_id: input.requestId,
        p_organization_id: input.organizationId,
        p_session_id: input.sessionId,
        p_model: input.model,
        p_estimated_input_tokens: input.estimatedInputTokens,
        p_max_output_tokens: input.maxOutputTokens,
      },
      reserveResultSchema,
    )
    if (!result.ok) return result
    return {
      ok: true,
      data: {
        allowed: result.data.allowed,
        mode: result.data.mode,
        reservationId: result.data.reservation_id,
        reason: result.data.reason,
        replayed: result.data.replayed,
      },
    }
  },

  async settle(input) {
    const result = await callRpc(
      'settle_chat_usage',
      {
        p_reservation_id: input.reservationId,
        p_input_tokens: input.inputTokens,
        p_output_tokens: input.outputTokens,
        p_model: input.model,
      },
      settleResultSchema,
    )
    if (!result.ok) return result
    return {
      ok: true,
      data: {
        reservationId: result.data.reservation_id,
        actualMicros: result.data.actual_micros,
        basis: result.data.basis,
        replayed: result.data.replayed,
      },
    }
  },

  async getStatus(organizationId, model) {
    const args: Record<string, unknown> = { p_organization_id: organizationId }
    if (model !== undefined) args.p_model = model
    return callRpc('get_organization_quota_status', args, statusResultSchema)
  },

  async hasModelPrice(model) {
    if (!supabaseAdmin) {
      return { ok: false, kind: 'not_configured', message: 'Supabase is not configured on this backend.' }
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('model_prices')
        .select('model')
        .eq('model', model)
        .abortSignal(AbortSignal.timeout(QUOTA_RPC_TIMEOUT_MS))
        .maybeSingle()
      if (error) {
        return { ok: false, kind: classifyError(error), message: error.message ?? 'Unknown query error' }
      }
      return { ok: true, data: data !== null }
    } catch (error) {
      return { ok: false, kind: 'transient', message: error instanceof Error ? error.message : String(error) }
    }
  },

  async expireStale() {
    const result = await callRpc(
      'expire_stale_chat_reservations',
      { p_older_than: `${RESERVATION_EXPIRY_MINUTES} minutes` },
      expireResultSchema,
      QUOTA_EXPIRE_RPC_TIMEOUT_MS,
    )
    if (!result.ok) return result
    return {
      ok: true,
      data: {
        expiredCount: result.data.expired_count,
        expiredMicros: result.data.expired_micros,
        organizationsProcessed: result.data.organizations_processed,
        organizationsSkippedLocked: result.data.organizations_skipped_locked,
        organizationsFailed: result.data.organizations_failed,
      },
    }
  },
}
