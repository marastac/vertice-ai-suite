-- Lead AI — leads role permissions (viewer read-only, member no-delete)
--
-- Run this once in the Supabase project's SQL editor, on a project that
-- already ran schema.sql/migrations-phase8.sql (organizations,
-- organization_members, is_org_member(), is_org_admin(), and the leads
-- table with organization_id already exist).
--
-- Root cause this fixes: leads_update/leads_delete used is_org_member(),
-- which is true for EVERY role in an organization — owner, admin, member,
-- and viewer alike. A signed-in 'viewer' could open a lead, edit its fields
-- (including via a direct PATCH to Supabase from the browser console, not
-- just through the app's "Editar" button), and the change persisted for
-- everyone — RLS never distinguished roles for this table at all.
--
-- Confirmed permission matrix this migration enforces at the RLS layer
-- (not just in the UI — see the accompanying frontend changes):
--   owner / admin : view, create, edit, delete
--   member        : view, create, edit — NOT delete
--   viewer        : view only — NOT create, NOT edit, NOT delete
--
-- This script is purely additive/replacing — it does not touch any existing
-- row of data. Safe to re-run (create-or-replace + drop-if-exists/create are
-- all idempotent).
--
-- What this does:
--   1. Creates is_org_editor(organization_id) — true for owner/admin/member,
--      false for viewer — same security definer + un-revoked-from-PUBLIC
--      pattern as the existing is_org_member()/is_org_admin(), so it works
--      correctly for both authenticated and anonymous callers (see the
--      comment on the grant statements below for exactly why this matters).
--   2. Replaces leads_insert: still allows a fully anonymous caller (public
--      /f/:formId and /c/:orgSlug visitors — auth.uid() is null) to create a
--      lead exactly as before; an AUTHENTICATED caller now additionally
--      needs is_org_editor(organization_id), so a signed-in viewer can no
--      longer create a lead manually from /leads.
--   3. Replaces leads_update: same is_org_editor(...) requirement for an
--      authenticated caller, replacing the old is_org_member(...) check.
--      The anonymous "or chat_session_id is not null" branch is preserved
--      unchanged — today's anonymous chat-lead updates actually go through
--      the upsert_chat_lead() RPC (SECURITY DEFINER, bypasses RLS entirely),
--      so this branch is a defensive fallback, not something this migration
--      needs to (or does) touch.
--   4. Replaces leads_delete: now is_org_admin(organization_id) instead of
--      is_org_member(organization_id) — member keeps create/edit but loses
--      delete, matching the confirmed matrix.
--
-- Nothing here touches organization_members, team_members, organization_invites,
-- forms, chat_configuration, chat_sessions, or any of their RPCs/policies —
-- this migration is scoped to the leads table alone.

-- ── 1. is_org_editor() ────────────────────────────────────────────────────
create or replace function is_org_editor(target_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = target_org_id and user_id = auth.uid() and role <> 'viewer'
  );
$$;

-- No `revoke ... from public` here, deliberately — same as is_org_member()/
-- is_org_admin() in schema.sql. leads_insert's `with check` below is
-- evaluated for anonymous /f/:formId and /c/:orgSlug submitters too, and
-- Postgres checks a function's EXECUTE privilege at parse/plan time for
-- every call appearing in the expression — regardless of whether an `or`
-- branch would make it unreachable at runtime for a given row. If this
-- function were revoked from PUBLIC (leaving only 'authenticated'), every
-- anonymous public form submission would fail with "permission denied for
-- function is_org_editor" instead of simply skipping that branch. The
-- explicit grant below is for documentation/clarity — anon can already call
-- this via the un-revoked PUBLIC grant, and always gets `false` back since
-- auth.uid() is null for an anonymous request, matching no membership row.
grant execute on function is_org_editor(uuid) to authenticated;

-- ── 2-4. leads INSERT/UPDATE/DELETE ──────────────────────────────────────
drop policy if exists "leads_insert" on leads;
create policy "leads_insert" on leads for insert with check (
  auth.uid() is null or is_org_editor(organization_id)
);

drop policy if exists "leads_update" on leads;
create policy "leads_update" on leads for update
  using (is_org_editor(organization_id) or chat_session_id is not null)
  with check (is_org_editor(organization_id) or chat_session_id is not null);

drop policy if exists "leads_delete" on leads;
create policy "leads_delete" on leads for delete using (is_org_admin(organization_id));

-- leads_select is intentionally UNCHANGED — still is_org_member(organization_id),
-- so owner/admin/member/viewer can all continue to see the leads list and
-- lead detail pages exactly as before. Not reproduced here since it's not
-- being modified — re-running `create policy "leads_select"` would error
-- ("policy already exists") without an unnecessary drop first, and there is
-- nothing to fix in it.

-- ── verification ──────────────────────────────────────────────────────────
-- 1) Confirm the function exists and (per the comment above) is NOT
--    revoked from public — proacl should show no explicit narrowing away
--    from the default, or should list 'authenticated' alongside the
--    original owner grant, but never show it revoked from everyone else.
select proname, proacl from pg_proc where proname = 'is_org_editor';

-- 2) Confirm the three policies now reference is_org_editor/is_org_admin,
--    not is_org_member.
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'leads' and policyname in ('leads_insert', 'leads_update', 'leads_delete');

-- 3) Manual smoke test (run as an authenticated 'viewer' from the app or via
--    supabase.rpc()/direct REST while signed in — NOT from the SQL editor,
--    which runs as a superuser-like role and would bypass RLS entirely,
--    proving nothing):
--      - Attempt to create a lead → should fail with an RLS policy violation.
--      - Attempt to update an existing lead's name → should fail the same way.
--      - Attempt to delete a lead → should fail the same way.
--      - A plain SELECT on /leads and a lead's detail page should still work.
--    Then repeat as a 'member': create/update should succeed, delete should
--    still fail. Then as 'owner'/'admin': all four should succeed.
