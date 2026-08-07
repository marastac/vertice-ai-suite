import { supabase } from '@/shared/lib/supabase-client'
import type { TeamMemberRepository } from './team-member-repository'
import type { TeamMember } from './types'

interface TeamMemberRow {
  id: string
  organization_id: string
  name: string
  email: string
  role: TeamMember['role']
}

function fromRow(row: TeamMemberRow): TeamMember {
  return { id: row.id, name: row.name, email: row.email, role: row.role }
}

export const supabaseTeamMemberRepository: TeamMemberRepository = {
  async list(organizationId) {
    const { data, error } = await supabase
      .from('team_members')
      .select('*')
      .eq('organization_id', organizationId)
      .order('name')
    if (error) throw error
    return data.map(fromRow)
  },

  async create(input) {
    const { data, error } = await supabase
      .from('team_members')
      .insert({ organization_id: input.organizationId, name: input.name, email: input.email, role: input.role })
      .select('*')
      .single()
    if (error) throw error
    return fromRow(data)
  },
}
