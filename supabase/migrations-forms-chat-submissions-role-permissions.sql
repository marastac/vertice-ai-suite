-- Lead AI — forms / chat_configuration / form_submissions role permissions
-- (viewer read-only, member no-delete)
--
-- Run this once in the Supabase project's SQL editor, on a project that
-- already ran schema.sql/migrations-phase8.sql/migrations-leads-role-
-- permissions.sql (organizations, organization_members, is_org_member(),
-- is_org_admin(), is_org_editor(), and the leads table's corrected
-- policies already exist).
--
-- Root cause this fixes: forms_insert/forms_update/forms_delete,
-- chat_configuration_insert/update/delete, and form_submissions_update/
-- delete all used is_org_member(), which is true for EVERY role in an
-- organization — owner, admin, member, and viewer alike. A signed-in
-- 'viewer' could open a form, edit its name/description/questions/scoring,
-- activate/deactivate it, duplicate it, or delete it (same for the chat
-- assistant's configuration) — including via a direct PATCH/POST/DELETE to
-- Supabase from the browser console, not just through the app's buttons —
-- and the change persisted for everyone. This is the exact same class of
-- bug migrations-leads-role-permissions.sql already fixed for `leads`,
-- never previously replicated to these three tables.
--
-- Confirmed permission matrix this migration enforces at the RLS layer
-- (not just in the UI — see the accompanying frontend changes):
--   owner / admin : view, create, edit, delete
--   member        : view, create, edit — NOT delete
--   viewer        : view only — NOT create, NOT edit, NOT delete,
--                   NOT activate/deactivate, NOT modify questions,
--                   NOT modify chat configuration, NOT modify/delete
--                   submissions
--
-- This script is purely additive/replacing — it does not touch any
-- existing row of data, and does not create any new function (is_org_editor
-- and is_org_admin already exist from migrations-leads-role-permissions.sql
-- / schema.sql). Safe to re-run (drop-if-exists/create is idempotent).
--
-- What this does NOT touch, on purpose:
--   - forms_select / chat_configuration_select stay `using (true)` (public)
--     — required for the no-login /f/:formId and /c/:orgSlug pages. Do not
--     gate these by role/membership; see the multi-tenancy note at the top
--     of schema.sql for why cross-organization SELECT on these two tables
--     is an accepted, documented trade-off, orthogonal to this fix.
--   - form_submissions_select stays is_org_member(organization_id)
--     (unchanged) — already correctly member-only, no public/anonymous
--     read path exists for submissions.
--   - form_submissions_insert stays `with check (true)` (public) — a
--     visitor submitting a public form at /f/:formId is never signed in,
--     and this flow must keep working with no login.
--   - organization_members, team_members, organization_invites, leads,
--     lead_activity, chat_sessions, chat_messages, and any RPC — this
--     migration is scoped to forms/chat_configuration/form_submissions
--     alone.
--
-- WITH CHECK on every UPDATE policy below mirrors its USING clause. This
-- is not redundant: USING controls which existing rows a caller may target
-- for update (evaluated against the row as it is *before* the write);
-- WITH CHECK validates the row as it would be *after* the write. Without a
-- matching WITH CHECK, an authorized caller could UPDATE a row they can
-- legitimately target and, in that same statement, change its
-- organization_id to move it into a different organization. With WITH
-- CHECK (is_org_editor(organization_id)) evaluated against the *new*
-- organization_id, the caller would additionally need to be an
-- is_org_editor member of that target organization too — the same
-- protection leads_update already relies on. Postgres RLS has no built-in
-- way to compare the new row against the old one directly inside a single
-- declarative policy; USING+WITH CHECK on the same column, both backed by
-- the same organization-membership check, is the established pattern this
-- project uses for that (see leads_update in schema.sql).

-- ── 1. forms ─────────────────────────────────────────────────────────────
drop policy if exists "forms_insert" on forms;
create policy "forms_insert" on forms for insert with check (is_org_editor(organization_id));

drop policy if exists "forms_update" on forms;
create policy "forms_update" on forms for update
  using (is_org_editor(organization_id))
  with check (is_org_editor(organization_id));

drop policy if exists "forms_delete" on forms;
create policy "forms_delete" on forms for delete using (is_org_admin(organization_id));

-- forms_select is intentionally UNCHANGED — still `using (true)`, so the
-- public /f/:formId page keeps resolving a form with no login. Not
-- reproduced here since it is not being modified.

-- ── 2. chat_configuration ────────────────────────────────────────────────
drop policy if exists "chat_configuration_insert" on chat_configuration;
create policy "chat_configuration_insert" on chat_configuration for insert with check (is_org_editor(organization_id));

drop policy if exists "chat_configuration_update" on chat_configuration;
create policy "chat_configuration_update" on chat_configuration for update
  using (is_org_editor(organization_id))
  with check (is_org_editor(organization_id));

drop policy if exists "chat_configuration_delete" on chat_configuration;
create policy "chat_configuration_delete" on chat_configuration for delete using (is_org_admin(organization_id));

-- chat_configuration_select is intentionally UNCHANGED — still
-- `using (true)`, so the public /c/:orgSlug page keeps resolving the chat
-- assistant's configuration with no login. Not reproduced here.

-- ── 3. form_submissions ──────────────────────────────────────────────────
drop policy if exists "form_submissions_update" on form_submissions;
create policy "form_submissions_update" on form_submissions for update
  using (is_org_editor(organization_id))
  with check (is_org_editor(organization_id));

drop policy if exists "form_submissions_delete" on form_submissions;
create policy "form_submissions_delete" on form_submissions for delete using (is_org_admin(organization_id));

-- form_submissions_select is intentionally UNCHANGED — still
-- is_org_member(organization_id); already correctly member-only.
-- form_submissions_insert is intentionally UNCHANGED — still
-- `with check (true)`, required for the public /f/:formId submission flow.
-- Neither is reproduced here since neither is being modified.

-- ── verification ──────────────────────────────────────────────────────────
-- 1) Confirm the seven policies now reference is_org_editor/is_org_admin,
--    not is_org_member, and that the three UPDATE policies carry a
--    matching with_check.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where (tablename, policyname) in (
  ('forms', 'forms_insert'), ('forms', 'forms_update'), ('forms', 'forms_delete'),
  ('chat_configuration', 'chat_configuration_insert'),
  ('chat_configuration', 'chat_configuration_update'),
  ('chat_configuration', 'chat_configuration_delete'),
  ('form_submissions', 'form_submissions_update'),
  ('form_submissions', 'form_submissions_delete')
)
order by tablename, policyname;

-- 2) Confirm forms_select / chat_configuration_select / form_submissions_select
--    / form_submissions_insert were left untouched (still public/member-only
--    exactly as before this migration).
select tablename, policyname, cmd, qual, with_check
from pg_policies
where (tablename, policyname) in (
  ('forms', 'forms_select'),
  ('chat_configuration', 'chat_configuration_select'),
  ('form_submissions', 'form_submissions_select'),
  ('form_submissions', 'form_submissions_insert')
)
order by tablename, policyname;

-- 3) Manual smoke test (run as an authenticated 'viewer' from the app or via
--    supabase.rpc()/direct REST while signed in — NOT from the SQL editor,
--    which runs as a superuser-like role and would bypass RLS entirely,
--    proving nothing):
--      - forms: create/edit/duplicate/activate-deactivate/delete a form
--        should all fail with an RLS policy violation. A plain SELECT on
--        /forms should still work.
--      - chat_configuration: saving or resetting /chat-settings should
--        fail with an RLS policy violation. Reading the current
--        configuration should still work, and /c/:orgSlug should still
--        load and start a conversation with no login at all.
--      - form_submissions: a direct PATCH/DELETE against an existing
--        submission row should fail. Submitting the public form at
--        /f/:formId (fully anonymous) should still succeed and still
--        create a lead + submission exactly as before.
--    Then repeat as a 'member': create/update should succeed on all three
--    tables, delete should still fail on all three. Then as 'owner'/'admin':
--    everything should succeed.
-- 4) Cross-organization check (run as an authenticated member of Org A):
--    attempt to UPDATE a form/chat_configuration/form_submissions row that
--    belongs to Org B (a different organization this user is not a member
--    of) — should fail with an RLS policy violation, both when only
--    touching Org B's row and when attempting to set organization_id from
--    an Org-A row to Org B's id.
