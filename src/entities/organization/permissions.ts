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

/**
 * Mirrors is_org_editor(organization_id) — the RLS helper leads_insert/
 * leads_update both call (see supabase/schema.sql) — so owner/admin/member
 * can create and edit leads, and a viewer cannot. Unlike canManageInvites
 * vs. canManageMembers above, this one genuinely IS the same underlying
 * concept as the SQL function of the same shape, not just a coincidentally
 * equal threshold — keep the `role !== 'viewer'` condition in sync with
 * is_org_editor() if either ever changes.
 */
export function canEditLeads(role: OrganizationRole | null): boolean {
  return role !== null && role !== 'viewer'
}

/**
 * Mirrors leads_delete's RLS (is_org_admin(organization_id)) — a member can
 * create/edit leads (see canEditLeads above) but not delete them; a viewer
 * can do neither. Declared separately from canManageInvites/canManageMembers
 * even though the boolean logic is identical, for the same "don't collapse
 * conceptually distinct permissions into one name" reason documented above.
 */
export function canDeleteLeads(role: OrganizationRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Mirrors is_org_editor(organization_id) on forms_insert/forms_update (see
 * supabase/schema.sql and
 * supabase/migrations-forms-chat-submissions-role-permissions.sql) —
 * owner/admin/member can create, edit, duplicate, and activate/deactivate a
 * form; a viewer cannot. Questions live on the same `forms.questions` jsonb
 * column, so this single check also covers "modificar preguntas" — there is
 * no separate questions table/policy to gate independently.
 */
export function canEditForms(role: OrganizationRole | null): boolean {
  return role !== null && role !== 'viewer'
}

/**
 * Mirrors forms_delete's RLS (is_org_admin(organization_id)) — same
 * owner/admin-only threshold as canDeleteLeads; a member can create/edit a
 * form but not delete it.
 */
export function canDeleteForms(role: OrganizationRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Mirrors is_org_editor(organization_id) on chat_configuration_insert/update
 * — owner/admin/member can edit the chat assistant's configuration, a
 * viewer can only read it. There is no delete affordance anywhere in the UI
 * for this singleton-per-organization row (ChatConfigRepository has no
 * delete method), so there is no matching canDeleteChatConfiguration.
 */
export function canEditChatConfiguration(role: OrganizationRole | null): boolean {
  return role !== null && role !== 'viewer'
}

/**
 * Mirrors organizations_update_members' RLS (is_org_admin(id) — see
 * supabase/schema.sql and supabase/migrations-organization-settings.sql).
 * Deliberately owner/admin-only, NOT is_org_editor's threshold — unlike
 * Leads/Forms/Chat Configuration, a 'member' is read-only on /settings by
 * product requirement, same as canManageInvites/canManageMembers above.
 */
export function canEditOrganizationSettings(role: OrganizationRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Same owner/admin-only threshold as canEditOrganizationSettings above —
 * kept as its own named function (not reused directly) because it gates a
 * conceptually different action (completing /onboarding vs. editing
 * /settings) that happens to share the same RLS boundary today
 * (organizations_update_members: is_org_admin(id) covers both, since both
 * end up as an UPDATE on the same `organizations` row). Used by
 * OnboardingGate.tsx, OnboardingPage.tsx, and AppShell.tsx so the three
 * places that need to know "can this role complete onboarding" never drift
 * out of sync with each other or with the RLS policy.
 */
export function canCompleteOrganizationOnboarding(role: OrganizationRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Mirrors webhook_configurations' RLS (is_org_admin(organization_id) — see
 * supabase/migrations-webhooks.sql) and, more importantly, the backend's
 * own requireAdminRole() check in server/src/services/webhook-auth.ts,
 * which re-verifies this server-side from the caller's JWT + a real
 * organization_members lookup rather than trusting anything the frontend
 * sends. This function only controls whether /integrations shows a
 * functional "Configurar"/"Probar webhook" action to a member/viewer —
 * hiding it here is UX, not the actual boundary; hitting the backend
 * directly as member/viewer is still rejected regardless.
 */
export function canManageWebhooks(role: OrganizationRole | null): boolean {
  return role === 'owner' || role === 'admin'
}
