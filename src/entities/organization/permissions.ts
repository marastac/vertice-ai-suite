import type { OrganizationRole } from './types'

/**
 * Mirrors organization_invites' RLS policies (is_org_admin-only for
 * select/insert/update/delete — see the RLS policy table in CLAUDE.md's
 * "Phase 8: Multi-tenancy" section and supabase/schema.sql). A member/viewer
 * can't create, list, or revoke invites at the database level either way —
 * this is what lets both TeamPage.tsx (hides the invite UI) and
 * useInvitesQuery (never even issues the request, see hooks.ts) share one
 * source of truth instead of two independently-maintained role checks that
 * could drift out of sync.
 */
export function canManageInvites(role: OrganizationRole | null): boolean {
  return role === 'owner' || role === 'admin'
}
