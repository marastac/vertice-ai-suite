import { dataBackend } from '@/shared/lib/data-backend'
import { localTeamMemberRepository } from './team-member-repository'
import { supabaseTeamMemberRepository } from './team-member-supabase-repository'
import type { TeamMemberRepository } from './team-member-repository'

export const activeTeamMemberRepository: TeamMemberRepository =
  dataBackend === 'supabase' ? supabaseTeamMemberRepository : localTeamMemberRepository
