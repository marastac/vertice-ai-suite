import { supabase } from '@/shared/lib/supabase-client'
import type { TeamMemberRepository } from './team-member-repository'
import type { TeamMember } from './types'

export const supabaseTeamMemberRepository: TeamMemberRepository = {
  async list() {
    const { data, error } = await supabase.from('team_members').select('*').order('name')
    if (error) throw error
    // Row shape (id/name/email/role) already matches TeamMember exactly.
    return data as TeamMember[]
  },
}
