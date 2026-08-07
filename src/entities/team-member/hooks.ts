import { useQuery } from '@tanstack/react-query'
import { useOrganization } from '@/entities/organization'
import { activeTeamMemberRepository } from './active-team-member-repository'

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
