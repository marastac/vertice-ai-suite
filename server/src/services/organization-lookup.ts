import { supabaseAdmin } from '../lib/supabase-client.js'
import { logger } from '../lib/logger.js'

/**
 * The four states a chat session's organization attribution can settle
 * into — kept semantically distinct on purpose, because each one requires
 * DIFFERENT behavior from the caller and conflating any two of them is
 * wrong for a real reason:
 *
 *   - `resolved`: Supabase is configured AND a real `organizations.id`
 *     matched this slug. Safe to spend Anthropic tokens and to record
 *     usage against it.
 *   - `not_configured`: this backend deployment has no Supabase credential
 *     at all (`supabaseAdmin` is `null` — see its own doc comment in
 *     lib/supabase-client.ts). This is the permitted development/local
 *     mode: there is no database to check against, ever, until credentials
 *     are added. Safe to spend Anthropic tokens WITHOUT recording usage —
 *     there is nowhere to record it. Final: never re-attempted for a given
 *     session, since nothing about this can change without an env change
 *     and a restart anyway.
 *   - `not_found`: Supabase IS configured, the query itself succeeded, but
 *     no `organizations` row matches this slug — a CONFIRMED absence, not
 *     a hiccup. This must NEVER be conflated with `unavailable`: an
 *     org that genuinely doesn't exist should never be retried on every
 *     single message of a conversation (wasteful, and it will never
 *     resolve differently unless someone actually creates that
 *     organization later — which the next message will naturally pick up,
 *     since `not_found` still allows exactly one retry path: a session
 *     that already settled to `not_found` is treated as final and is
 *     NOT re-queried — see chat-service.ts::ensureOrganizationResolved()).
 *     This state BLOCKS spending Anthropic tokens — a real org's slug
 *     typo'd or an attacker-supplied fabricated slug must never get free,
 *     unattributed Anthropic usage.
 *   - `unavailable`: Supabase IS configured, but the lookup itself
 *     genuinely failed (network error, timeout, unexpected exception) even
 *     after one retry — we don't know whether this organization exists or
 *     not. This is the one state that's explicitly NOT final: callers
 *     should retry resolving this on the next message (see
 *     chat-service.ts::ensureOrganizationResolved()). Also BLOCKS spending
 *     Anthropic tokens, for the same reason as `not_found` — a real
 *     organization's conversation must never consume Anthropic silently
 *     un-attributed just because of a transient outage.
 */
export type OrganizationResolution =
  | { status: 'resolved'; organizationId: string }
  | { status: 'not_configured' }
  | { status: 'not_found' }
  | { status: 'unavailable' }

// A single immediate retry — not a retry system: no backoff, no queue, no
// configurable attempt count. Just enough to not treat one single transient
// blip (a dropped connection, a momentary timeout) as a confirmed outage.
// Only applies to genuine query FAILURES — a successful query that simply
// found no row is never retried here (see queryOrganizationIdBySlug()'s
// caller below): that outcome is `not_found`, settled on the first try.
const MAX_ATTEMPTS = 2

async function queryOrganizationIdBySlug(orgSlug: string): Promise<string | null> {
  // Only ever called when supabaseAdmin is non-null — see the caller.
  const { data, error } = await supabaseAdmin!.from('organizations').select('id').eq('slug', orgSlug).maybeSingle()
  if (error) throw new Error(error.message)
  return (data?.id as string | undefined) ?? null
}

/**
 * Resolves a public chat org slug to its real Supabase `organizations.id`
 * — used to attach usage-metering events to the correct organization, and
 * to gate whether a message may spend Anthropic tokens at all (see
 * chat-service.ts::ensureOrganizationResolved()). This is a real,
 * authoritative lookup against the same `organizations` table every other
 * multi-tenant table in this project already trusts — never an invented or
 * guessed association, and never something the frontend gets to supply
 * (there is no `organizationId` field anywhere in the chat request
 * schemas — see server/src/schemas/chat.ts).
 */
export async function resolveOrganizationIdForSlug(orgSlug: string): Promise<OrganizationResolution> {
  if (!supabaseAdmin) {
    return { status: 'not_configured' }
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const id = await queryOrganizationIdBySlug(orgSlug)
      // A successful query that simply found no matching row is a
      // CONFIRMED absence — settled immediately, never retried, and never
      // conflated with a query FAILURE (which is what the retry loop
      // above exists for).
      return id ? { status: 'resolved', organizationId: id } : { status: 'not_found' }
    } catch (error) {
      lastError = error
    }
  }

  logger.warn('Could not resolve organization for usage metering after retrying — treating as temporarily unavailable', {
    message: lastError instanceof Error ? lastError.message : String(lastError),
  })
  return { status: 'unavailable' }
}
