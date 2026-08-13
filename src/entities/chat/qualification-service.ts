import { activeLeadRepository } from '@/entities/lead'
import { activeChatSessionRepository } from './active-chat-session-repository'
import type { ChatQualificationResult } from './types'

/**
 * Creates or updates a Lead from a chat qualification result. Mirrors
 * entities/form/submission-service.ts: only ever acts once the model has
 * actually captured a real email — never invents a placeholder address.
 *
 * The create-or-update decision itself is delegated to
 * activeLeadRepository.upsertByChatSession() so it can be atomic on the
 * Supabase backend (a plain list-then-write here was only ever safe when
 * each browser had an isolated localStorage store — see
 * lead-supabase-repository.ts for the race this closes). The `existing`
 * lookup below is a separate, best-effort read used only to compute
 * name/company fallbacks; it doesn't affect how many leads end up created.
 */
/**
 * organizationId is an explicit parameter, not read from "the current
 * user's active organization" — the public chat page that calls this is
 * anonymous (no login, no organization membership). PublicChatPage already
 * resolved it once, at session bootstrap, via
 * ChatConfigRepository.getBySlug() — see PublicChatPage.tsx.
 */
export async function syncLeadFromQualification(
  organizationId: string,
  sessionId: string,
  qualification: ChatQualificationResult,
): Promise<string | undefined> {
  if (!qualification.email) return undefined

  const existing = await activeLeadRepository.getByChatSessionId(organizationId, sessionId)

  const patch = {
    organizationId,
    name: qualification.contactName ?? existing?.name ?? 'Lead sin nombre',
    email: qualification.email,
    phone: qualification.phone ?? undefined,
    company: qualification.company ?? existing?.company ?? 'Sin empresa',
    source: 'chat' as const,
    status: qualification.status,
    score: qualification.score,
    notes: qualification.summary,
  }

  const lead = await activeLeadRepository.upsertByChatSession(organizationId, sessionId, patch)
  await activeChatSessionRepository.linkLead(sessionId, lead.id)
  return lead.id
}
