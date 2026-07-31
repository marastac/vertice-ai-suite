import type { BadgeVariant } from '@/shared/ui/Badge'
import type { ChatQualificationStatus, ChatTone } from './types'

export const chatToneLabel: Record<ChatTone, string> = {
  professional: 'Profesional',
  friendly: 'Cercano',
  concise: 'Conciso',
  consultative: 'Consultivo',
}

export const chatQualificationStatusLabel: Record<ChatQualificationStatus, string> = {
  disqualified: 'Descalificado',
  qualifying: 'En calificación',
  qualified: 'Calificado',
}

export const chatQualificationStatusBadgeVariant: Record<ChatQualificationStatus, BadgeVariant> = {
  disqualified: 'danger',
  qualifying: 'warning',
  qualified: 'success',
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
const dateFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' })

export function formatChatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso))
}

export function formatChatDate(iso: string): string {
  return dateFormatter.format(new Date(iso))
}
