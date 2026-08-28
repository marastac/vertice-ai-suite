import type { BadgeVariant } from '@/shared/ui/Badge'
import type { BusinessType, OrganizationInvite, OrganizationRole } from './types'

export const BUSINESS_TYPES: BusinessType[] = ['content_creator', 'course_creator', 'online_business']

export const businessTypeLabel: Record<BusinessType, string> = {
  content_creator: 'Creador de contenido',
  course_creator: 'Curso online',
  online_business: 'Negocio que vende por internet',
}

export const businessTypeDescription: Record<BusinessType, string> = {
  content_creator: 'Construyes una audiencia y trabajas con marcas, patrocinios o productos digitales.',
  course_creator: 'Vendes un curso, mentoría o infoproducto y quieres calificar a los interesados antes de inscribirlos.',
  online_business: 'Vendes productos o servicios por internet y quieres calificar y dar seguimiento a tus clientes.',
}

export const organizationRoleLabel: Record<OrganizationRole, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  member: 'Miembro',
  viewer: 'Visualizador',
}

export const organizationRoleBadgeVariant: Record<OrganizationRole, BadgeVariant> = {
  owner: 'gradient',
  admin: 'info',
  member: 'neutral',
  viewer: 'neutral',
}

export const inviteStatusLabel: Record<OrganizationInvite['status'], string> = {
  pending: 'Pendiente',
  accepted: 'Aceptada',
  revoked: 'Revocada',
  expired: 'Expirada',
}

export const inviteStatusBadgeVariant: Record<OrganizationInvite['status'], BadgeVariant> = {
  pending: 'warning',
  accepted: 'success',
  revoked: 'danger',
  expired: 'neutral',
}

export function getInviteUrl(token: string): string {
  return `${window.location.origin}/accept-invite/${token}`
}

const inviteExpiresAtFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' })

export function formatInviteExpiresAt(iso: string): string {
  return inviteExpiresAtFormatter.format(new Date(iso))
}
