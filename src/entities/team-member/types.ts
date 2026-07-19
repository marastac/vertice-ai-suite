export type TeamMemberRole = 'owner' | 'admin' | 'member'

export interface TeamMember {
  id: string
  name: string
  email: string
  role: TeamMemberRole
}
