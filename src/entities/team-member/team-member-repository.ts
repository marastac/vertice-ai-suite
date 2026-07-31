import { mockTeamMembers } from './mock-data'
import type { TeamMember } from './types'

export interface TeamMemberRepository {
  list(): Promise<TeamMember[]>
}

/**
 * Read-only — there is no team-management UI yet (TeamPage is a
 * placeholder), so this mirrors the static mock list exactly rather than
 * adding create/update/remove that nothing calls.
 */
export const localTeamMemberRepository: TeamMemberRepository = {
  async list() {
    return mockTeamMembers
  },
}
