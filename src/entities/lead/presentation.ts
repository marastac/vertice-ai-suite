import type { BadgeVariant } from '@/shared/ui/Badge'
import type { LeadSource, LeadStatus } from './schema'

export const leadStatusLabel: Record<LeadStatus, string> = {
  new: 'Nuevo',
  qualifying: 'En calificación',
  qualified: 'Calificado',
  disqualified: 'Descalificado',
  converted: 'Convertido',
}

export const leadStatusBadgeVariant: Record<LeadStatus, BadgeVariant> = {
  new: 'info',
  qualifying: 'warning',
  qualified: 'success',
  disqualified: 'danger',
  converted: 'gradient',
}

export const leadSourceLabel: Record<LeadSource, string> = {
  chat: 'Chat con IA',
  form: 'Formulario',
  widget: 'Widget',
  manual: 'Manual',
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
const dateFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' })
const currencyFormatter = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

export function formatLeadDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso))
}

export function formatLeadDate(iso: string): string {
  return dateFormatter.format(new Date(iso))
}

export function formatLeadBudget(amount: number | undefined): string {
  if (amount === undefined) return 'Sin especificar'
  return currencyFormatter.format(amount)
}
