// Kept in sync with OrganizationRole (entities/organization/types.ts) — accepting
// a team invite (see accept_invite() in supabase/schema.sql) creates a row here
// with whatever role the invite granted, 'viewer' included, so a viewer's real
// role shows correctly on /team instead of being silently coerced to 'member'.
export type TeamMemberRole = 'owner' | 'admin' | 'member' | 'viewer'

/**
 * Fase 10: the only roles update_member_role() accepts as a *new* role — see
 * its check in supabase/schema.sql. 'owner' is deliberately excluded: there is
 * no ownership-transfer feature, so granting it is never allowed through this
 * path. Kept as a distinct type (not just "TeamMemberRole minus owner" inlined
 * everywhere) so the UI's role picker can enumerate exactly this set.
 */
export type AssignableTeamMemberRole = Exclude<TeamMemberRole, 'owner'>

export interface TeamMember {
  id: string
  name: string
  email: string
  role: TeamMemberRole
}
