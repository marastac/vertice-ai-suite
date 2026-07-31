import { activeLeadRepository } from '@/entities/lead'
import { localStorageChatSessionRepository } from './chat-session-repository'
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
export async function syncLeadFromQualification(
  sessionId: string,
  qualification: ChatQualificationResult,
): Promise<string | undefined> {
  if (!qualification.email) return undefined

  const existing = await activeLeadRepository.getByChatSessionId(sessionId)

  const patch = {
    name: qualification.contactName ?? existing?.name ?? 'Lead sin nombre',
    email: qualification.email,
    phone: qualification.phone ?? undefined,
    company: qualification.company ?? existing?.company ?? 'Sin empresa',
    source: 'chat' as const,
    status: qualification.status,
    score: qualification.score,
    notes: qualification.summary,
  }

  const lead = await activeLeadRepository.upsertByChatSession(sessionId, patch)
  await localStorageChatSessionRepository.linkLead(sessionId, lead.id)
  return lead.id
}
