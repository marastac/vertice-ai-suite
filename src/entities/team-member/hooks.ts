import { useQuery } from '@tanstack/react-query'
import { activeTeamMemberRepository } from './active-team-member-repository'

export const teamMemberKeys = {
  all: ['team-members'] as const,
  list: () => [...teamMemberKeys.all, 'list'] as const,
}

export function useTeamMembersQuery() {
  return useQuery({
    queryKey: teamMemberKeys.list(),
    queryFn: () => activeTeamMemberRepository.list(),
  })
}
