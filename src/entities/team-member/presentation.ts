import type { BadgeVariant } from '@/shared/ui/Badge'
import type { TeamMemberRole } from './types'

export const teamMemberRoleLabel: Record<TeamMemberRole, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  member: 'Miembro',
}

export const teamMemberRoleBadgeVariant: Record<TeamMemberRole, BadgeVariant> = {
  owner: 'gradient',
  admin: 'info',
  member: 'neutral',
}
