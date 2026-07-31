import { leadStatusLabel } from './presentation'
import type { Lead } from './types'

/**
 * Pure activity-log decision logic, shared between the localStorage and
 * Supabase lead repositories — each just wraps these messages into
 * whatever storage shape it needs (an embedded LeadActivityEntry[] array
 * for localStorage, a lead_activity row insert for Supabase).
 */
export function buildCreateActivityMessage(input: { chatSessionId?: string; formId?: string }): string {
  if (input.chatSessionId) return 'Lead creado automáticamente desde una conversación de chat con IA.'
  if (input.formId) return 'Lead creado automáticamente desde un formulario.'
  return 'Lead creado manualmente por el equipo.'
}

const CONTACT_FIELDS = ['name', 'email', 'phone', 'company', 'position', 'source', 'estimatedBudget', 'notes', 'score'] as const

export function buildUpdateActivityMessages(
  existing: Lead,
  patch: Partial<Lead>,
  resolveAssignedName: (id: string | undefined) => string | undefined,
): string[] {
  const messages: string[] = []

  if (patch.status && patch.status !== existing.status) {
    messages.push(`Estado actualizado a "${leadStatusLabel[patch.status]}".`)
  }

  if ('assignedTo' in patch && patch.assignedTo !== existing.assignedTo) {
    const name = resolveAssignedName(patch.assignedTo)
    messages.push(name ? `Lead asignado a ${name}.` : 'Se ha quitado la persona asignada.')
  }

  const contactFieldsChanged = CONTACT_FIELDS.some((field) => field in patch && patch[field] !== existing[field])
  if (contactFieldsChanged) {
    messages.push('Información del lead actualizada.')
  }

  return messages
}
