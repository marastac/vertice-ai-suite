import type { BadgeVariant } from '@/shared/ui/Badge'
import type { FormStatus, QuestionType } from './schema'

export const formStatusLabel: Record<FormStatus, string> = {
  draft: 'Borrador',
  active: 'Activo',
}

export const formStatusBadgeVariant: Record<FormStatus, BadgeVariant> = {
  draft: 'neutral',
  active: 'success',
}

export const questionTypeLabel: Record<QuestionType, string> = {
  short_text: 'Texto corto',
  long_text: 'Texto largo',
  email: 'Correo electrónico',
  phone: 'Teléfono',
  number: 'Número',
  single_choice: 'Opción única',
  multiple_choice: 'Opción múltiple',
  yes_no: 'Sí / No',
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
const dateFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' })

export function formatFormDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso))
}

export function formatFormDate(iso: string): string {
  return dateFormatter.format(new Date(iso))
}
