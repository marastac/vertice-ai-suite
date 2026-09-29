import { supabaseAdmin } from '../lib/supabase-client.js'
import { logger } from '../lib/logger.js'

export type UsageEventPurpose = 'reply' | 'extraction'

export interface UsageEventInput {
  organizationId: string
  sessionId: string
  purpose: UsageEventPurpose
  model: string
  inputTokens: number
  outputTokens: number
}

// Local to THIS insert only — deliberately not a global timeout on
// `supabaseAdmin` (would also affect Webhooks/HubSpot, which have their own
// separate, already-reviewed reasoning and aren't part of this fix).
// `usage_events` is a single small-row insert with no reason to ever
// legitimately take long; 5s is generous for the normal case and short
// enough that a hung Supabase/PostgREST response can never leave the chat
// response (or, during an ordered shutdown, server.close()) waiting on it
// indefinitely.
const USAGE_INSERT_TIMEOUT_MS = 5_000

/**
 * Records ONE real Anthropic usage event in `usage_events` (see
 * supabase/migrations-usage-events.sql). NEVER throws — this function is
 * the single enforcement point of the "metering can never break the chat"
 * requirement. Every failure — Supabase not configured, a network error,
 * an insert error, or this call's own 5s timeout — is caught here and only
 * ever logged; the caller (chat-service.ts) now `await`s this to reduce
 * loss on an ordered shutdown, which is exactly why a bounded timeout here
 * is required: without one, a hung Supabase response could leave that
 * `await` — and the chat response it's part of — pending indefinitely.
 *
 * The timeout uses PostgREST's own native `.abortSignal(AbortSignal.timeout(...))`
 * support (confirmed in the installed @supabase/postgrest-js's own type
 * declarations and JSDoc example) — no new dependency, no global client
 * change, no Promise.race wrapper needed.
 *
 * Never logs conversation content, tokens counts aside (not PII) — the
 * input to this function never carries the lead's email/phone/message
 * text in the first place, only ids, a purpose label, a model name, and
 * two integers.
 *
 * Writes via `supabaseAdmin` (service_role) — the SAME credential Webhooks
 * and HubSpot already use server-side; no new credential, no new secret.
 * `usage_events` has no INSERT policy for anon/authenticated at all (see
 * the migration), so this is the only code path that can ever write it.
 */
export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  if (!supabaseAdmin) {
    // Metering requires Supabase, same optionality as Webhooks/HubSpot —
    // an unconfigured deployment simply doesn't get usage events, never a
    // crash and never a fabricated organization/session association.
    return
  }

  try {
    const { error } = await supabaseAdmin
      .from('usage_events')
      .insert({
        organization_id: input.organizationId,
        session_id: input.sessionId,
        purpose: input.purpose,
        model: input.model,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
      })
      .abortSignal(AbortSignal.timeout(USAGE_INSERT_TIMEOUT_MS))
    if (error) {
      // Covers both a real Postgres/RLS error AND an aborted-by-timeout
      // request — PostgREST's client surfaces an abort as an `error` here
      // (via its own AbortError handling) rather than a thrown exception in
      // most cases, but the outer catch below is kept regardless as a
      // second safety net for any case where it instead throws.
      logger.warn('Failed to record usage event — chat continues normally', {
        purpose: input.purpose,
        message: error.message,
      })
    }
  } catch (error) {
    logger.warn('Failed to record usage event — chat continues normally', {
      purpose: input.purpose,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
