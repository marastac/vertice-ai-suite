// Kept in sync with OrganizationRole (entities/organization/types.ts) — accepting
// a team invite (see accept_invite() in supabase/schema.sql) creates a row here
// with whatever role the invite granted, 'viewer' included, so a viewer's real
// role shows correctly on /team instead of being silently coerced to 'member'.
export type TeamMemberRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface TeamMember {
  id: string
  name: string
  email: string
  role: TeamMemberRole
}
