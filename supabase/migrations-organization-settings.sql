-- Lead AI — real /settings (organization profile: name, support email,
-- brand color) + organizations_update_members role fix (owner/admin only)
--
-- Run this once in the Supabase project's SQL editor, on a project that
-- already ran schema.sql/migrations-phase8.sql (organizations,
-- organization_members, is_org_member(), is_org_admin() already exist).
-- NOT executed by Claude — this file is prepared for you to run manually.
--
-- What this does:
--   1. Adds two nullable columns to `organizations`: support_email (free
--      text) and brand_color (constrained to #RRGGBB at the database level,
--      not just in the frontend's Zod schema). Purely additive — existing
--      rows get NULL in both, which the frontend already treats as "not
--      set yet" (src/entities/organization/organization-supabase-repository.ts's
--      normalizeOrganization()).
--   2. Replaces organizations_update_members: it used is_org_member(id),
--      true for EVERY role in an organization — owner, admin, member, and
--      viewer alike. A signed-in 'member' or 'viewer' could UPDATE the
--      organizations row directly (e.g. rename the organization) via a
--      direct REST call, not just through the app. This is the exact same
--      class of bug already fixed for leads/forms/chat_configuration/
--      form_submissions in earlier migrations, never previously applied to
--      `organizations` itself. Now is_org_admin(id) — owner/admin only.
--
--      Deliberately NOT is_org_editor (which also includes 'member') — the
--      product requirement for /settings is stricter than Leads/Forms/Chat
--      Configuration: member is read-only here.
--
--      This does NOT break onboarding, but only because a matching
--      frontend fix landed alongside this policy (do not apply this SQL
--      without it already deployed): completeOnboarding() (Phase 9) is
--      called from OnboardingPage.tsx, reachable by ANY role, not just the
--      organization's owner — a member/viewer invited before the owner
--      finishes their own onboarding would otherwise land on /onboarding
--      too (OnboardingGate.tsx redirects based on onboarding status alone,
--      not role) and hit an RLS rejection on submit. The fix: OnboardingGate.tsx
--      now only redirects a role that canCompleteOrganizationOnboarding()
--      allows (owner/admin) to /onboarding in the first place; a member/
--      viewer of a not-yet-onboarded organization instead sees a read-only
--      "still being set up" notice (AppShell.tsx + OrganizationPendingSetup.tsx),
--      and OnboardingPage.tsx itself also refuses to render the completion
--      form for a role that fails that same check, even on a direct visit
--      to /onboarding. With that in place, completeOnboarding() is only
--      ever invoked by owner/admin, so it already satisfies is_org_admin(id)
--      by construction — not merely by the common-case assumption that the
--      first user is always the owner.
--
-- This script is purely additive/replacing — it does not touch any
-- existing row of data. Safe to re-run (add-column-if-not-exists and
-- drop-if-exists/create are all idempotent).
--
-- What this does NOT touch, on purpose:
--   - organizations_select_public stays `using (true)` (public) — required
--     for the no-login /f/:formId and /c/:orgSlug pages, which resolve an
--     organization's id from its slug for an anonymous visitor. Do not gate
--     this by role/membership.
--   - organizations_insert_self is unchanged.
--   - id, slug, created_by, created_at, business_type,
--     onboarding_completed_at are all untouched by this migration and are
--     never part of the /settings UPDATE payload (see
--     UpdateOrganizationSettingsInput in
--     entities/organization/organization-repository.ts — an explicit
--     whitelist of exactly name/support_email/brand_color, enforced at the
--     TypeScript level in addition to this RLS fix).
--   - organization_members, organization_invites, team_members, leads,
--     forms, chat_configuration, form_submissions, lead_activity,
--     chat_sessions, chat_messages, and any RPC — this migration is scoped
--     to `organizations` alone.

-- ── 1. new columns ───────────────────────────────────────────────────────
alter table organizations add column if not exists support_email text;
alter table organizations add column if not exists brand_color text;

-- Idempotent-safe: drop-then-add rather than a bare `add constraint`, since
-- re-running this script on a project that already has the constraint
-- would otherwise error ("constraint already exists").
alter table organizations drop constraint if exists organizations_brand_color_check;
alter table organizations add constraint organizations_brand_color_check
  check (brand_color is null or brand_color ~ '^#[0-9A-Fa-f]{6}$');

-- ── 2. organizations_update_members: owner/admin only ───────────────────
drop policy if exists "organizations_update_members" on organizations;
create policy "organizations_update_members" on organizations for update
  using (is_org_admin(id))
  with check (is_org_admin(id));

-- organizations_select_public / organizations_insert_self are intentionally
-- UNCHANGED — not reproduced here since neither is being modified.

-- ── verification ──────────────────────────────────────────────────────────
-- 1) Confirm both columns exist with the expected type/nullability, and
--    that the check constraint is in place.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'organizations' and column_name in ('support_email', 'brand_color')
order by column_name;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'organizations'::regclass and conname = 'organizations_brand_color_check';

-- 2) Confirm organizations_update_members now references is_org_admin, not
--    is_org_member, and carries a matching with_check.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename = 'organizations' and policyname = 'organizations_update_members';

-- 3) Confirm organizations_select_public / organizations_insert_self were
--    left untouched.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename = 'organizations' and policyname in ('organizations_select_public', 'organizations_insert_self');

-- 4) Manual smoke test (run as an authenticated 'member'/'viewer' from the
--    app or via supabase.rpc()/direct REST while signed in — NOT from the
--    SQL editor, which runs as a superuser-like role and would bypass RLS
--    entirely, proving nothing):
--      - /settings should load and show the current name/support email/
--        brand color as read-only, with no functional "Guardar cambios"
--        button.
--      - A direct PATCH against `organizations` for that user's own
--        organization (e.g. changing `name`) should fail with an RLS
--        policy violation.
--      - A plain SELECT on /settings' data (or any public page) should
--        still work — organizations_select_public is unchanged.
--    Then repeat as 'owner'/'admin': editing name/support email/brand
--    color and saving should succeed, and the new name should appear in
--    the sidebar/header without a page reload.
-- 5) Cross-organization check (run as an authenticated admin of Org A):
--    attempt to UPDATE Org B's `organizations` row (a different
--    organization this user is not a member of) — should fail with an RLS
--    policy violation, both when only touching Org B's row and when
--    attempting to set `id` to Org B's id from an Org-A row.
