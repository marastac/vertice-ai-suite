import { supabaseAdmin } from '../lib/supabase-client.js'
import { logger } from '../lib/logger.js'
import type { ChatConfigurationInput } from '../schemas/chat.js'

/**
 * Result of looking up the SERVER-SIDE `chat_configuration` row for an
 * already-resolved `organizationId` — the authoritative source of truth a
 * `resolved` chat session's config must come from (see chat-service.ts's
 * createSession()/ensureConfigTrusted()), never whatever `config` object a
 * direct client happened to send in the request body.
 *
 * Three states, deliberately kept as distinct as
 * organization-lookup.ts::OrganizationResolution's own four — a query that
 * genuinely failed must never be reported as "no configuration exists",
 * since callers treat the two very differently (a permanent 404 vs. a
 * retryable 503):
 *   - `found`: the row exists and was read successfully.
 *   - `not_found`: the query succeeded but no `chat_configuration` row
 *     matches this organization_id (e.g. an organization that exists but
 *     never finished onboarding its chat assistant — see Phase 9).
 *   - `unavailable`: the query itself failed (network error, Supabase
 *     error) — genuinely unknown, never treated as `not_found`.
 */
export type ChatConfigLookup =
  | { status: 'found'; config: ChatConfigurationInput }
  | { status: 'not_found' }
  | { status: 'unavailable' }

/**
 * Exact column shape of `chat_configuration` (see supabase/schema.sql) —
 * this repository is the backend's own row↔ChatConfigurationInput mapper.
 * Deliberately NOT imported from src/entities/chat/chat-config-supabase-repository.ts
 * (the frontend's equivalent mapper, `fromRow()`/`toRow()`): the backend
 * package has its own `node_modules`/build and must never depend on
 * frontend source (see CLAUDE.md's "Backend (server/)" section) — the two
 * mappers independently target the same table and the same
 * `ChatConfigurationInput`/`ChatConfiguration` field set (assistantName,
 * welcomeMessage, agencyDescription, servicesOffered, tone, language,
 * questionsToCollect, criteria, minQualifiedScore, additionalInstructions,
 * isActive — see server/src/schemas/chat.ts's `chatConfigurationSchema`,
 * the one canonical shape this backend already uses everywhere else), but
 * there is no shared-code path between them to reuse without introducing
 * exactly the frontend→backend dependency this must avoid.
 */
interface ChatConfigurationRow {
  assistant_name: string
  welcome_message: string
  agency_description: string
  services_offered: string
  tone: ChatConfigurationInput['tone']
  language: string
  questions_to_collect: string[]
  criteria: ChatConfigurationInput['criteria']
  min_qualified_score: number
  additional_instructions: string | null
  is_active: boolean
}

function fromRow(row: ChatConfigurationRow): ChatConfigurationInput {
  return {
    assistantName: row.assistant_name,
    welcomeMessage: row.welcome_message,
    agencyDescription: row.agency_description,
    servicesOffered: row.services_offered,
    tone: row.tone,
    language: row.language,
    questionsToCollect: row.questions_to_collect,
    criteria: row.criteria,
    minQualifiedScore: row.min_qualified_score,
    additionalInstructions: row.additional_instructions ?? undefined,
    isActive: row.is_active,
  }
}

// Local to THIS query only — deliberately not a global timeout on
// `supabaseAdmin` (would also affect organization lookup, usage_events,
// HubSpot, and Webhooks, none of which are part of this fix). Same value
// and same native mechanism as usage-events-repository.ts's INSERT
// timeout, for the same reason: this query gates whether a chat session
// can ever be created/continued at all, so a hung Supabase response here
// must never leave createSession()/ensureConfigTrusted() — and the
// request/message they're part of — waiting indefinitely.
const CHAT_CONFIG_QUERY_TIMEOUT_MS = 5_000

/**
 * Loads the real `chat_configuration` row for `organizationId` via
 * `supabaseAdmin` (service_role — bypasses RLS; the same credential
 * organization-lookup.ts and usage-events-repository.ts already use
 * server-side, no new credential). Only ever called once `organizationId`
 * has already been authoritatively resolved from `orgSlug` (see
 * organization-lookup.ts::resolveOrganizationIdForSlug()) — never accepts
 * or trusts anything from the request body.
 *
 * Bounded by a 5-second timeout using PostgREST's own native
 * `.abortSignal(AbortSignal.timeout(...))` support — the exact same
 * mechanism and constant as usage-events-repository.ts's INSERT timeout
 * (confirmed compatible with the installed @supabase/postgrest-js; no new
 * dependency, no Promise.race wrapper). If Supabase takes longer than 5s,
 * the request is aborted and this resolves to `{ status: 'unavailable' }`
 * — the SAME classification as any other query failure (see the `catch`
 * below and ChatConfigLookup's own doc comment for why a timeout must
 * never be confused with `not_found`). Callers (createSession()/
 * ensureConfigTrusted() in chat-service.ts) already treat `unavailable` as
 * "block, controlled error, no fallback to client config, no Anthropic" —
 * this timeout only bounds HOW LONG that decision can take, it never
 * changes what the decision is.
 *
 * Deliberately a single attempt, no retry loop (unlike
 * organization-lookup.ts's 2-attempt retry) — this hardening's scope is
 * "never trust client config when Supabase is configured", not a new
 * resiliency mechanism; a transient failure (including this timeout) still
 * correctly resolves to `unavailable` and the caller blocks accordingly.
 * The next message a visitor sends is already a natural retry opportunity
 * (ensureConfigTrusted() re-attempts this on any session whose configSource
 * isn't settled yet), so no retry is added here.
 */
export async function loadChatConfigurationForOrganization(organizationId: string): Promise<ChatConfigLookup> {
  if (!supabaseAdmin) {
    // Defensive only — every real call site already checked
    // organization.status === 'resolved' first, which itself requires
    // supabaseAdmin to be non-null (see organization-lookup.ts). Never
    // reachable in practice, but never silently treated as "found" either.
    return { status: 'unavailable' }
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('chat_configuration')
      .select(
        'assistant_name, welcome_message, agency_description, services_offered, tone, language, questions_to_collect, criteria, min_qualified_score, additional_instructions, is_active',
      )
      .eq('organization_id', organizationId)
      // .abortSignal() must be chained BEFORE .maybeSingle() — the
      // installed @supabase/postgrest-js types only expose it on
      // PostgrestFilterBuilder/PostgrestTransformBuilder; .maybeSingle()
      // narrows to a plain PostgrestBuilder that doesn't re-declare it
      // (confirmed against node_modules/@supabase/postgrest-js/dist/index.d.mts).
      .abortSignal(AbortSignal.timeout(CHAT_CONFIG_QUERY_TIMEOUT_MS))
      .maybeSingle()

    if (error) {
      // Covers both a real Postgres/RLS error AND an aborted-by-timeout
      // request — same reasoning as usage-events-repository.ts's own
      // `.abortSignal()` usage: PostgREST's client usually surfaces an
      // abort as an `error` here rather than a thrown exception, but the
      // outer `catch` below is kept regardless as a second safety net.
      logger.warn('Could not load chat_configuration for organization — treating as temporarily unavailable', {
        message: error.message,
      })
      return { status: 'unavailable' }
    }

    if (!data) {
      return { status: 'not_found' }
    }

    return { status: 'found', config: fromRow(data as ChatConfigurationRow) }
  } catch (error) {
    logger.warn('Could not load chat_configuration for organization — treating as temporarily unavailable', {
      message: error instanceof Error ? error.message : String(error),
    })
    return { status: 'unavailable' }
  }
}
