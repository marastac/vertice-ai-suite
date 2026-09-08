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

/**
 * Fase 10: mirrors update_member_role()/remove_organization_member()'s own
 * `is_org_admin` check (see supabase/schema.sql) — a member/viewer can't
 * change anyone's role or remove them at the database level either way.
 * Same value as canManageInvites today, but declared separately: these are
 * conceptually distinct permissions (inviting vs. managing existing members)
 * that happen to share a threshold now — don't collapse them into one name,
 * or a future change to one would silently affect the other.
 */
export function canManageMembers(role: OrganizationRole | null): boolean {
  return role === 'owner' || role === 'admin'
}
