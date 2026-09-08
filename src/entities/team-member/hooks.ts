import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOrganization } from '@/entities/organization'
import { activeTeamMemberRepository } from './active-team-member-repository'
import type { AssignableTeamMemberRole } from './types'

export const teamMemberKeys = {
  all: ['team-members'] as const,
  list: (organizationId: string | undefined) => [...teamMemberKeys.all, 'list', organizationId] as const,
}

export function useTeamMembersQuery() {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: teamMemberKeys.list(organization?.id),
    queryFn: () => activeTeamMemberRepository.list(organization!.id),
    enabled: Boolean(organization),
  })
}

/**
 * Fase 10. Callers pass only the target's team_members id and the new role —
 * organizationId is injected from the active organization, same pattern as
 * every other mutation in this codebase. Does NOT also invalidate leadKeys:
 * a role change never touches leads.assigned_to (only removal does) — see
 * useRemoveMemberMutation below.
 */
export function useUpdateMemberRoleMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ teamMemberId, newRole }: { teamMemberId: string; newRole: AssignableTeamMemberRole }) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeTeamMemberRepository.updateRole(organization.id, teamMemberId, newRole)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamMemberKeys.list(organization?.id) }),
  })
}

/**
 * Fase 10. Removing a member may unassign their leads (leads.assigned_to →
 * NULL, via the FK's ON DELETE SET NULL — see supabase/schema.sql). This
 * hook only owns the team-member side of that; TeamPage.tsx additionally
 * invalidates leadKeys itself on success, since entities/team-member
 * deliberately doesn't import from entities/lead (entities/lead already
 * imports FROM entities/team-member — see lead-repository.ts — so the
 * reverse import would be circular).
 */
export function useRemoveMemberMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (teamMemberId: string) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeTeamMemberRepository.removeMember(organization.id, teamMemberId)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: teamMemberKeys.list(organization?.id) }),
  })
}
