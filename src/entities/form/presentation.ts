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

/** The public, no-login submission URL for a form — see src/features/public-form/PublicFormPage.tsx (route /f/:formId). Only meaningful to share while the form's status is 'active'; PublicFormPage itself shows a "not available" message for a draft form, so callers should gate the share UI on status rather than relying on that fallback alone. */
export function getPublicFormUrl(formId: string): string {
  return `${window.location.origin}/f/${formId}`
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
const dateFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' })

export function formatFormDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso))
}

export function formatFormDate(iso: string): string {
  return dateFormatter.format(new Date(iso))
}
