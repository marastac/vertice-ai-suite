-- Lead AI — schema (Phase 6 persistence + Phase 8 multi-tenancy + Phase 9 onboarding)
--
-- Run this once in the Supabase project's SQL editor (Project → SQL Editor →
-- New query → paste → Run). Meant for a FRESH project. If your project
-- already has Phase 6/7 data in it, do NOT run this file — run
-- supabase/migrations-phase8.sql then supabase/migrations-phase9.sql instead,
-- which backfill non-destructively. This file assumes empty tables.
--
-- ── Phase 9: onboarding ──────────────────────────────────────────────────
-- `organizations.business_type`/`onboarding_completed_at` (below) drive a
-- one-time setup screen (`/onboarding`) for brand-new organizations only —
-- see CLAUDE.md's "Phase 9: Onboarding & copy" section. `organizations_update_members`
-- (below) is owner/admin-only (`is_org_admin`) — completeOnboarding() is
-- only ever called by a role that satisfies that, because OnboardingGate.tsx
-- and OnboardingPage.tsx both gate on canCompleteOrganizationOnboarding()
-- (entities/organization/permissions.ts) before a member/viewer can reach
-- or submit the completion form at all. A member/viewer of a not-yet-
-- onboarded organization sees a read-only notice instead (AppShell.tsx +
-- OrganizationPendingSetup.tsx), never the form.
--
-- ── Phase 8: multi-tenancy, read this first ─────────────────────────────
-- Every table below now belongs to an `organizations` row via
-- `organization_id`. Row Level Security enforces that a user can only
-- read/write rows in organizations they are a member of
-- (`organization_members`), via the `is_org_member`/`is_org_admin` helper
-- functions defined right below. Three tables — `organizations`, `forms`,
-- `chat_configuration` — keep a PUBLIC (unauthenticated) SELECT policy on
-- purpose, because `/f/:formId` and `/c/:orgSlug` are pre-existing,
-- deliberately no-login product features (a lead filling out a form, or a
-- website visitor starting a chat, is never signed in). This means RLS does
-- NOT provide read isolation for those three tables — the app's own
-- queries must filter by organization_id for their authenticated
-- list views (see entities/{form,chat}'s Supabase repositories). For every
-- other table (leads, form_submissions, lead_activity, team_members,
-- organization_members, organization_invites), RLS *does* fully isolate
-- reads, so a bug in the app's query filtering can't leak another
-- organization's rows.
--
-- created_by columns below are deliberately a plain `uuid`, NOT
-- `references auth.users(id)`. Referencing the auth schema from a SQL-editor
-- paste is a known Supabase permission/grants friction point (the exact
-- role/grants context the editor runs under can reject it with a permission
-- error) — and because the editor sends a whole pasted script as one
-- implicit transaction, a single failing statement anywhere rolls back the
-- entire script, including tables earlier in the file.

-- ── organizations, organization_members, organization_invites ───────────
-- The tenancy backbone. A user's accessible organizations are whichever
-- rows they have a matching organization_members row for.
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_by uuid,
  -- Phase 9: nullable on purpose. NULL business_type means "not chosen yet";
  -- NULL onboarding_completed_at means "show /onboarding on next login" —
  -- see entities/organization/OrganizationProvider.tsx's OnboardingGate.
  business_type text check (business_type in ('content_creator', 'course_creator', 'online_business')),
  onboarding_completed_at timestamptz,
  -- /settings (see src/features/settings/SettingsPage.tsx): both nullable —
  -- NULL support_email/brand_color just means "not set yet", not an error.
  -- brand_color is constrained to #RRGGBB at the database level too, not
  -- only in the frontend's Zod schema (entities/organization/schema.ts).
  support_email text,
  brand_color text check (brand_color is null or brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now()
);

create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  invited_by uuid references auth.users(id),
  token uuid not null default gen_random_uuid() unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);

-- Helper functions used by every org-scoped RLS policy below. Declared
-- `security definer` + `set search_path = public` — the standard Supabase
-- pattern for avoiding RLS recursion: a policy on organization_members that
-- queried organization_members directly (via a plain subquery) would
-- re-trigger the same policy for the subquery's own rows. Running the
-- lookup inside a security-definer function (owned by the role that ran
-- this script, which owns these tables and is therefore exempt from their
-- RLS) sidesteps that recursion entirely. `stable` lets Postgres cache the
-- result within one statement instead of re-evaluating it per row.
create or replace function is_org_member(target_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = target_org_id and user_id = auth.uid()
  );
$$;

create or replace function is_org_admin(target_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = target_org_id and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

-- Leads permissions (see the leads table's RLS below): owner/admin/member can
-- create and edit leads, viewer can only read. 'not role = viewer' rather
-- than an explicit 'in (owner, admin, member)' list, so a future new role
-- defaults to editor-level access unless deliberately excluded — matches the
-- product intent that viewer is the one deliberately restricted role, not
-- that every other role had to be enumerated by hand.
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

-- No `revoke ... from public` on any of these three — they keep Postgres'
-- default at-creation EXECUTE grant to PUBLIC (which includes `anon`). This
-- is deliberate, not an oversight: leads_insert's `with check` (below) is
-- evaluated for anonymous /f/:formId and /c/:orgSlug submitters too, and
-- Postgres checks a function's EXECUTE privilege at parse/plan time for
-- every call in the expression tree — regardless of whether an `or` branch
-- would make it unreachable at runtime for a given row. Revoking from
-- `anon` here would make every anonymous public form submission fail with
-- "permission denied for function is_org_editor", not just skip the branch.
-- The `grant ... to authenticated` lines exist for documentation/clarity —
-- the functions already work for anon via the un-revoked PUBLIC grant.
grant execute on function is_org_member(uuid) to authenticated;
grant execute on function is_org_admin(uuid) to authenticated;
grant execute on function is_org_editor(uuid) to authenticated;

alter table organizations enable row level security;
drop policy if exists "organizations_select_public" on organizations;
drop policy if exists "organizations_insert_self" on organizations;
drop policy if exists "organizations_update_members" on organizations;
-- Public on purpose: /c/:orgSlug must resolve an org's id from its slug for
-- an anonymous chat visitor. Only name/slug/id are exposed today — revisit
-- if a sensitive column (billing info, etc.) is ever added to this table.
create policy "organizations_select_public" on organizations for select using (true);
-- Self-serve bootstrap: any signed-in user can create ONE organization row
-- for themselves (the app auto-provisions one on first login — see
-- entities/organization/OrganizationProvider.tsx). Ownership is granted
-- separately below, scoped so this can't be used to claim someone else's org.
create policy "organizations_insert_self" on organizations for insert
  with check (auth.uid() is not null and created_by = auth.uid());
-- owner/admin only (is_org_admin), not is_org_member — a signed-in
-- 'member'/'viewer' could otherwise UPDATE this row directly (e.g. rename
-- the organization) via a raw REST call, same class of bug already fixed
-- for leads/forms/chat_configuration/form_submissions. WITH CHECK mirrors
-- USING for the same reason as those: this table's own `id` is its
-- "organization_id" (there's no separate foreign column to protect), so
-- WITH CHECK (is_org_admin(id)) evaluated against the *new* row keeps a
-- caller from updating their way into administering a different
-- organization's row than the one USING already authorized them for.
create policy "organizations_update_members" on organizations for update
  using (is_org_admin(id))
  with check (is_org_admin(id));

alter table organization_members enable row level security;
drop policy if exists "organization_members_select" on organization_members;
drop policy if exists "organization_members_insert_owner_bootstrap" on organization_members;
drop policy if exists "organization_members_update_admins" on organization_members;
drop policy if exists "organization_members_delete_admins" on organization_members;
create policy "organization_members_select" on organization_members for select
  using (is_org_member(organization_id));
-- Deliberately narrow: a user may only insert THEMSELVES, as 'owner', into
-- an organization THEY themselves just created. This is what makes
-- first-login auto-provisioning safe without opening a privilege-escalation
-- hole — without the `organizations.created_by = auth.uid()` check, any
-- signed-in user could grant themselves owner of an arbitrary org id.
-- Joining an existing organization (via invite acceptance) is intentionally
-- NOT covered by this policy — that path goes through accept_invite()
-- below instead, a SECURITY DEFINER function that inserts the
-- organization_members row itself (as the function owner, bypassing this
-- policy) only after validating the invite token/status/expiry/email
-- server-side. See the "Team invites" block after organization_invites'
-- policies, right below.
create policy "organization_members_insert_owner_bootstrap" on organization_members for insert
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and exists (select 1 from organizations o where o.id = organization_id and o.created_by = auth.uid())
  );
-- Fase 10 — member management. Tightened beyond plain is_org_admin(organization_id)
-- specifically because that alone does NOT check which row is being touched: an
-- admin could otherwise UPDATE their own row to role='owner' (self-escalation),
-- or UPDATE/DELETE the real owner's row, via a direct PostgREST call — neither
-- requires going through any RPC. Both are blocked here, at the RLS layer,
-- regardless of which client code path is used:
--   - user_id <> auth.uid(): nobody can touch their own membership row through
--     this policy (change_role/remove_member are admin-acting-on-someone-else
--     operations only — self-service "leave the organization" is a deliberately
--     separate, not-yet-built feature with different rules, see CLAUDE.md).
--   - role <> 'owner' (USING): the owner's row can never be the target of an
--     UPDATE or DELETE through this policy, by anyone, including another admin.
--   - with check (role <> 'owner') on UPDATE: the *resulting* role can never be
--     'owner' either — this is what stops "admin promotes X (or themselves) to
--     owner". There is no ownership-transfer feature; the owner row is fixed
--     for the organization's lifetime as far as this policy is concerned.
-- update_member_role()/remove_organization_member() (further below) are the
-- sanctioned application entry points and re-validate all of this themselves
-- (SECURITY DEFINER bypasses RLS, so they can't rely on it) — this policy is
-- the backstop for a direct, RPC-bypassing REST call attempting the same thing.
create policy "organization_members_update_admins" on organization_members for update
  using (is_org_admin(organization_id) and user_id <> auth.uid() and role <> 'owner')
  with check (role <> 'owner');
create policy "organization_members_delete_admins" on organization_members for delete
  using (is_org_admin(organization_id) and user_id <> auth.uid() and role <> 'owner');

alter table organization_invites enable row level security;
drop policy if exists "organization_invites_select_admins" on organization_invites;
drop policy if exists "organization_invites_insert_admins" on organization_invites;
drop policy if exists "organization_invites_update_admins" on organization_invites;
drop policy if exists "organization_invites_delete_admins" on organization_invites;
-- Never public — an invite's token is effectively a bearer credential to
-- join the organization, so only existing owners/admins may ever see or
-- manage these rows via the normal client. No policy here means no anon
-- access, by default-deny.
create policy "organization_invites_select_admins" on organization_invites for select
  using (is_org_admin(organization_id));
create policy "organization_invites_insert_admins" on organization_invites for insert
  with check (is_org_admin(organization_id) and invited_by = auth.uid());
create policy "organization_invites_update_admins" on organization_invites for update
  using (is_org_admin(organization_id));
create policy "organization_invites_delete_admins" on organization_invites for delete
  using (is_org_admin(organization_id));

-- ── Team invites: get_invite_by_token, accept_invite ────────────────────
-- A not-yet-a-member invitee can't pass any RLS policy on
-- organization_members or organization_invites above (both are
-- member/admin-only, by design — a token is a bearer credential). These
-- two SECURITY DEFINER functions are the only path in.
create or replace function get_invite_by_token(p_token uuid)
returns table (
  organization_name text,
  organization_slug text,
  role text,
  status text,
  expires_at timestamptz,
  is_usable boolean
)
language sql
security definer
stable
set search_path = public
as $$
  -- Reveals only the organization's already-public name/slug (see
  -- organizations_select_public above) and the offered role — never the
  -- invite's email or who sent it. Safe to expose to anon: a logged-out
  -- visitor must be able to preview an invite before signing in/up.
  -- is_usable is computed here, not left for the frontend to derive from
  -- expires_at, so a client clock never factors into the decision;
  -- coalesce(...) treats a NULL expires_at (shouldn't happen — the column
  -- is `not null` — but this function doesn't assume that survives every
  -- future schema edit) as not usable rather than as an unknown/NULL flag.
  select
    o.name,
    o.slug,
    i.role,
    i.status,
    i.expires_at,
    coalesce(i.status = 'pending' and i.expires_at > now(), false) as is_usable
  from organization_invites i
  join organizations o on o.id = i.organization_id
  where i.token = p_token;
$$;

revoke execute on function get_invite_by_token(uuid) from public;
grant execute on function get_invite_by_token(uuid) to anon, authenticated;

-- accept_invite() derives organization_id/role from the token row itself —
-- NEVER from a client-supplied parameter, or any signed-in caller could
-- grant themselves an arbitrary role in an arbitrary organization. It
-- validates, in this exact order, before ever touching
-- organization_members: (1) the token exists, (2) the invite is still
-- 'pending' and not expired — a NULL expires_at is treated as unusable
-- rather than silently passing, since `null <= now()` evaluates to
-- NULL/unknown in plpgsql, which a plain `if` does NOT treat as true, even
-- though the column is `not null` today, (3) the authenticated caller's own
-- email (read from the JWT claim via auth.jwt(), not from auth.users —
-- avoids the auth-schema grants friction documented at the top of this
-- file) matches organization_invites.email, case-insensitively. Only after
-- all three pass does it even look at organization_members — the insert
-- is safe to run unconditionally (ON CONFLICT DO NOTHING covers an
-- already-a-member caller, e.g. a double-click or a redundant invite).
-- It also inserts a matching team_members row (ON CONFLICT DO NOTHING on
-- the (organization_id, email) unique index, same reasoning) — without
-- this, an accepted invitee became a real organization_members row but
-- never showed up on /team's member list or the "Persona asignada" lead
-- dropdown, both of which read team_members, not organization_members
-- (these two were never merged — see CLAUDE.md's Phase 8 section — but an
-- accepted invite is exactly the case where they need to stay in sync).
-- The invite is marked 'accepted' only after both inserts succeed, so a
-- failure here leaves it 'pending' (retryable) rather than lying about
-- having completed — same "mark completion last" reasoning as Phase 9's
-- onboarding flow.
create or replace function accept_invite(p_token uuid)
returns table (organization_id uuid, organization_slug text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite organization_invites%rowtype;
  v_org organizations%rowtype;
  v_caller_email text;
  v_team_member_name text;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_invite
  from organization_invites
  where token = p_token
  for update; -- locks the row so two simultaneous acceptances of the same token can't race

  if not found then
    raise exception 'INVITE_NOT_FOUND';
  end if;

  if v_invite.status <> 'pending'
     or v_invite.expires_at is null
     or v_invite.expires_at <= now() then
    raise exception 'INVITE_NOT_USABLE';
  end if;

  v_caller_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_caller_email = '' or v_caller_email <> lower(v_invite.email) then
    raise exception 'EMAIL_MISMATCH';
  end if;

  select * into v_org from organizations where id = v_invite.organization_id;

  insert into organization_members (organization_id, user_id, role)
  values (v_invite.organization_id, auth.uid(), v_invite.role)
  on conflict on constraint organization_members_organization_id_user_id_key do nothing;

  -- Same full_name-else-email-local-part derivation OrganizationProvider.tsx
  -- uses for the auto-provisioned owner's own team_members row (see
  -- deriveOrganizationName there) — full_name is a standard Supabase Auth JWT
  -- claim (auth.jwt() -> 'user_metadata'), no extra round trip needed.
  v_team_member_name := coalesce(
    nullif(trim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
    split_part(v_invite.email, '@', 1)
  );

  insert into team_members (organization_id, name, email, role)
  values (v_invite.organization_id, v_team_member_name, v_invite.email, v_invite.role)
  on conflict (organization_id, email) do nothing;

  update organization_invites set status = 'accepted' where id = v_invite.id;

  return query select v_org.id, v_org.slug;
end;
$$;

revoke execute on function accept_invite(uuid) from public;
grant execute on function accept_invite(uuid) to authenticated;

-- ── team_members ────────────────────────────────────────────────────────
-- Currently a hardcoded 3-row array in the frontend. Migrated here so
-- leads.assigned_to can be a real foreign key. Not wired to organization_members
-- (a "team member" you can assign a lead to is still a separate, simpler
-- concept from a real authenticated org member with a role — see
-- CLAUDE.md's Phase 8 section for why these two aren't merged yet).
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer'))
);
-- Email no longer globally unique (Phase 6) — two different organizations
-- may each have their own assignable "Alex Morgan"-shaped row. Unique per org instead.
create unique index if not exists team_members_org_email_key on team_members (organization_id, email);

-- 'viewer' was added after this table's first release — this ALTER is a no-op
-- on a fresh install (the create table above already allows it) but widens an
-- existing project's constraint when this file is re-run. Needed so
-- accept_invite() above can insert a team_members row for an invite that
-- granted 'viewer', not just 'admin'/'member'.
alter table team_members drop constraint if exists team_members_role_check;
alter table team_members add constraint team_members_role_check check (role in ('owner', 'admin', 'member', 'viewer'));

alter table team_members enable row level security;
drop policy if exists "team_members_select" on team_members;
drop policy if exists "team_members_insert" on team_members;
drop policy if exists "team_members_update" on team_members;
drop policy if exists "team_members_delete" on team_members;
-- SELECT stays is_org_member — everyone on the team can see the roster
-- (matches /team's UI, which never gated the member list itself, only the
-- invite/management actions). INSERT/UPDATE/DELETE were tightened to
-- is_org_admin as part of Fase 10 (member management): this table is no
-- longer just an assignable-name list a viewer could freely edit — since
-- accept_invite() and the organization_members sync trigger keep it as a
-- mirror of real membership, a non-admin editing/deleting a row here would
-- corrupt that mirror (e.g. delete a real member's assignable-name row,
-- silently unassigning their leads) even though it can't grant them real
-- access on its own. The sync trigger itself runs SECURITY DEFINER and so
-- bypasses these policies entirely — this only restricts direct client writes.
create policy "team_members_select" on team_members for select using (is_org_member(organization_id));
create policy "team_members_insert" on team_members for insert with check (is_org_admin(organization_id));
create policy "team_members_update" on team_members for update using (is_org_admin(organization_id));
create policy "team_members_delete" on team_members for delete using (is_org_admin(organization_id));

-- ── Fase 10: member management (role changes, removal) ──────────────────
-- organization_members is the single source of truth for identity/permissions.
-- team_members is a synced projection, used only for /team's roster display
-- and the leads.assigned_to FK — never authoritative for access control.
--
-- The sync is a database TRIGGER, not application discipline, precisely
-- because "remember to write both tables" is what caused the bug fixed in
-- accept_invite() (see CLAUDE.md's Team invites section): a trigger makes it
-- structurally impossible for organization_members to change without
-- team_members following, regardless of which code path (these RPCs, a
-- future RPC, a manual SQL statement) performs the change. accept_invite()'s
-- own explicit team_members insert is untouched by this — the trigger only
-- fires on UPDATE OF role / DELETE, not INSERT, so the already-working,
-- already-fixed acceptance flow is not affected at all.
create or replace function sync_team_member_on_organization_member_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_name text;
begin
  if tg_op = 'DELETE' then
    select email into v_email from auth.users where id = old.user_id;
    if v_email is not null then
      delete from team_members where organization_id = old.organization_id and email = v_email;
    end if;
    return old;
  end if;

  -- tg_op = 'UPDATE' (the trigger below only fires on UPDATE OF role, so
  -- new.role <> old.role is already guaranteed, but this stays defensive in
  -- case that trigger definition is ever loosened later).
  if new.role is distinct from old.role then
    select email, coalesce(nullif(trim(raw_user_meta_data ->> 'full_name'), ''), split_part(email, '@', 1))
      into v_email, v_name
    from auth.users where id = new.user_id;

    if v_email is not null then
      insert into team_members (organization_id, name, email, role)
      values (new.organization_id, v_name, v_email, new.role)
      on conflict (organization_id, email) do update set role = excluded.role;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists organization_members_sync_team_members on organization_members;
create trigger organization_members_sync_team_members
  after update of role or delete on organization_members
  for each row execute function sync_team_member_on_organization_member_change();

-- update_member_role()/remove_organization_member() are the only sanctioned
-- application entry points for changing a member's role or removing them.
-- Both are SECURITY DEFINER, which means they run as the function owner and
-- therefore BYPASS organization_members' RLS entirely — so every rule the
-- RLS policies above enforce is re-validated here too, explicitly, in the
-- same ordered-checks style as accept_invite(): authenticate, authorize
-- (caller is admin), validate input, resolve the target, refuse to touch the
-- owner, refuse to touch the caller's own row, only then mutate. The RLS
-- policies remain the backstop against a direct REST call that skips these
-- functions entirely — neither layer alone is considered sufficient.
--
-- Both take a team_members.id (p_team_member_id), not a raw user_id — that's
-- the id /team's UI already has from useTeamMembersQuery(), and it avoids
-- ever exposing auth.users identifiers to the client. Internally, the email
-- on that team_members row is used to resolve the real organization_members
-- row via auth.users — the same "resolve identity through auth.users email,
-- never accept a client-supplied id for it" approach accept_invite() uses
-- for the caller's own identity.
create or replace function update_member_role(p_organization_id uuid, p_team_member_id uuid, p_new_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_email text;
  v_target_user_id uuid;
  v_target_current_role text;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not is_org_admin(p_organization_id) then
    raise exception 'NOT_ADMIN';
  end if;

  -- 'owner' is never an assignable value here — there is no ownership
  -- transfer feature; the organization's owner is fixed for its lifetime as
  -- far as this function is concerned (see CLAUDE.md's Team invites section).
  if p_new_role not in ('admin', 'member', 'viewer') then
    raise exception 'INVALID_ROLE';
  end if;

  select email into v_target_email
  from team_members
  where id = p_team_member_id and organization_id = p_organization_id;

  if v_target_email is null then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  select om.user_id, om.role into v_target_user_id, v_target_current_role
  from organization_members om
  join auth.users u on u.id = om.user_id
  where om.organization_id = p_organization_id and lower(u.email) = lower(v_target_email);

  if v_target_user_id is null then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  if v_target_current_role = 'owner' then
    raise exception 'CANNOT_MODIFY_OWNER';
  end if;

  if v_target_user_id = auth.uid() then
    raise exception 'CANNOT_MODIFY_SELF';
  end if;

  update organization_members
  set role = p_new_role
  where organization_id = p_organization_id and user_id = v_target_user_id;
  -- team_members is updated automatically by organization_members_sync_team_members above.
end;
$$;

revoke execute on function update_member_role(uuid, uuid, text) from public;
grant execute on function update_member_role(uuid, uuid, text) to authenticated;

create or replace function remove_organization_member(p_organization_id uuid, p_team_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_email text;
  v_target_user_id uuid;
  v_target_current_role text;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not is_org_admin(p_organization_id) then
    raise exception 'NOT_ADMIN';
  end if;

  select email into v_target_email
  from team_members
  where id = p_team_member_id and organization_id = p_organization_id;

  if v_target_email is null then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  select om.user_id, om.role into v_target_user_id, v_target_current_role
  from organization_members om
  join auth.users u on u.id = om.user_id
  where om.organization_id = p_organization_id and lower(u.email) = lower(v_target_email);

  if v_target_user_id is null then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  if v_target_current_role = 'owner' then
    raise exception 'CANNOT_REMOVE_OWNER';
  end if;

  if v_target_user_id = auth.uid() then
    raise exception 'CANNOT_REMOVE_SELF';
  end if;

  -- Only removes the organization_members row (this org's access) — never
  -- touches auth.users, so the person's Supabase Auth account, and any
  -- membership they hold in OTHER organizations, is completely untouched.
  -- team_members is removed automatically by the sync trigger above;
  -- leads.assigned_to pointing at that team_members row is set to NULL by
  -- its existing `on delete set null` FK (see the leads table below) — a
  -- removed member's leads become unassigned, never deleted.
  delete from organization_members
  where organization_id = p_organization_id and user_id = v_target_user_id;
end;
$$;

revoke execute on function remove_organization_member(uuid, uuid) from public;
grant execute on function remove_organization_member(uuid, uuid) to authenticated;

-- ── forms ────────────────────────────────────────────────────────────────
create table if not exists forms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null check (status in ('draft', 'active')),
  questions jsonb not null default '[]',
  created_by uuid, -- always NULL until a later phase wires it to auth.uid() on insert
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table forms enable row level security;
drop policy if exists "forms_select" on forms;
drop policy if exists "forms_insert" on forms;
drop policy if exists "forms_update" on forms;
drop policy if exists "forms_delete" on forms;
-- Public on purpose: /f/:formId is a no-login public submission page —
-- see the multi-tenancy note at the top of this file.
create policy "forms_select" on forms for select using (true);
-- INSERT/UPDATE: owner/admin/member (is_org_editor) — a viewer can view an
-- organization's forms but not create, edit, duplicate, or activate/
-- deactivate one. Questions live on this same row's `questions` jsonb
-- column, so this also covers "modify questions" — there is no separate
-- table/policy for them. WITH CHECK mirrors USING on the update policy so
-- an UPDATE can never move a row's organization_id into an organization
-- the caller isn't an editor of either (same pattern as leads_update).
create policy "forms_insert" on forms for insert with check (is_org_editor(organization_id));
create policy "forms_update" on forms for update
  using (is_org_editor(organization_id))
  with check (is_org_editor(organization_id));
-- DELETE: owner/admin only, same threshold as leads_delete — a member can
-- create/edit a form but not delete it.
create policy "forms_delete" on forms for delete using (is_org_admin(organization_id));

-- ── leads ────────────────────────────────────────────────────────────────
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  company text not null,
  "position" text,
  source text not null check (source in ('chat', 'form', 'widget', 'manual')),
  status text not null check (status in ('new', 'qualifying', 'qualified', 'disqualified', 'converted')),
  score integer not null default 0 check (score between 0 and 100),
  estimated_budget numeric,
  assigned_to uuid references team_members(id) on delete set null,
  notes text,
  form_id uuid references forms(id) on delete set null, -- safe FK: the form is read before a lead is created
  submission_id uuid, -- deliberately NO FK — see note below
  chat_session_id text, -- deliberately NO FK — chat_sessions isn't in Postgres this phase
  created_by uuid, -- always NULL until a later phase wires it to auth.uid() on insert
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);

-- Structurally prevents the qualification-service dedup race: two
-- qualification events for the same chat session can never produce two
-- leads, because the second insert/update must upsert onto this key.
--
-- Deliberately NOT a partial index (`where chat_session_id is not null`):
-- PostgREST's upsert(..., { onConflict: 'chat_session_id' }) issues a plain
-- `ON CONFLICT (chat_session_id)`, which Postgres only matches against a
-- non-partial unique constraint/index (a partial one raises 42P10 "no
-- unique or exclusion constraint matching the ON CONFLICT specification").
-- A plain unique index still allows unlimited leads with a NULL
-- chat_session_id — Postgres unique indexes never treat NULL as equal to
-- another NULL, so the partial predicate was never actually necessary.
-- Global (not per-organization) is intentional: chat_session_id is already
-- a server-minted UUID, unique across all organizations on its own.
create unique index if not exists leads_chat_session_id_key
  on leads (chat_session_id);

alter table leads enable row level security;
drop policy if exists "leads_select" on leads;
drop policy if exists "leads_insert" on leads;
drop policy if exists "leads_update" on leads;
drop policy if exists "leads_delete" on leads;
create policy "leads_select" on leads for select using (is_org_member(organization_id));
-- Fase C (see migrations-form-submissions-rls.sql for the full reasoning):
-- the anonymous branch (`auth.uid() is null`) this policy used to have was
-- removed — a public form submission no longer writes here directly at
-- all; it goes through POST /api/forms/:formId/submissions (service_role,
-- bypasses RLS regardless of this policy) instead. The public chat's lead
-- creation was never affected either way — it always went through the
-- upsert_chat_lead() RPC (SECURITY DEFINER, also bypasses RLS). What
-- remains is exactly the authenticated dashboard's own requirement:
-- member/admin/owner of *that* organization, never 'viewer' — unchanged
-- from before this fase.
create policy "leads_insert" on leads for insert with check (
  is_org_editor(organization_id)
);
-- UPDATE: an authenticated org member can update a lead in their org only if
-- they're not a 'viewer' (normal dashboard editing — status changes, the
-- "Editar" form); an anonymous caller may only update a lead that already
-- has a chat_session_id — i.e. exactly the upsertByChatSession() path used
-- mid-conversation on the public chat page to refine an existing lead's
-- score. In practice that anonymous path today goes through the
-- upsert_chat_lead() RPC (SECURITY DEFINER, bypasses this policy entirely),
-- so this branch is currently unreachable — kept as a defensive fallback in
-- case a future change reintroduces a direct anonymous update, exactly as
-- it existed before this change. An anonymous caller can never update a
-- lead created via the manual "Nuevo lead" form or a form submission (those
-- have no chat_session_id).
create policy "leads_update" on leads for update
  using (is_org_editor(organization_id) or chat_session_id is not null)
  with check (is_org_editor(organization_id) or chat_session_id is not null);
-- DELETE: owner/admin only — member can create/edit but not delete, per the
-- confirmed permission matrix. This is the one operation where member and
-- viewer are NOT treated the same as each other and member is NOT treated
-- the same as owner/admin — is_org_admin already expresses exactly that.
create policy "leads_delete" on leads for delete using (is_org_admin(organization_id));

-- Why leads.submission_id has NO foreign key:
-- submission-service.ts creates the Lead FIRST (already stamped with a
-- client-generated submissionId), then creates the FormSubmission SECOND.
-- A straightforward FK on leads.submission_id -> form_submissions(id) would
-- fail on every single form submission, because the referenced row doesn't
-- exist yet at insert time. This is normal runtime behavior, not a one-time
-- migration wrinkle — so the column stays a loose uuid, unenforced.

-- ── RPC: upsert_chat_lead ────────────────────────────────────────────────
-- Public chat (/c/:orgSlug) bug fix. entities/chat/qualification-service.ts
-- ::syncLeadFromQualification() calls activeLeadRepository.upsertByChatSession(),
-- which used to (1) upsert the lead row via PostgREST, then (2) SELECT it
-- back — both to return it to the caller and to decide which activity
-- message to log. Step 2 always failed for an anonymous chat visitor:
-- leads_select/lead_activity_select are gated by is_org_member(organization_id),
-- unconditionally false with no auth.uid(), so the visitor's own successful
-- upsert could never be read back (PGRST116 "no rows"). This is the same
-- class of bug the public FORM flow hit — but a real upsert can't use that
-- fix's trick (mint an id client-side, skip the read-back): a client-chosen
-- id would corrupt the existing row's primary key on a conflict-UPDATE.
--
-- This function does the upsert, the lead_activity insert, and the read,
-- all inside ONE security definer call, so RLS is bypassed only for the
-- exact single row this call just wrote — never an arbitrary id or list —
-- and only for operations an anonymous caller was already allowed to
-- perform directly (leads_insert is `with check (true)`; leads_update
-- already permits an anonymous caller when chat_session_id is not null,
-- which this function always sets; lead_activity_insert is already public).
-- No new access is granted to anon; this only removes an impossible
-- read-after-write step for a request the caller was already authorized to
-- make. It does NOT expose a general-purpose leads SELECT — anon still has
-- no way to list or fetch an arbitrary lead.
create or replace function public.upsert_chat_lead(
  p_organization_id uuid,
  p_chat_session_id text,
  p_name text,
  p_email text,
  p_phone text,
  p_company text,
  p_status text,
  p_score integer,
  p_notes text
)
returns leads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead leads;
  v_is_new boolean;
begin
  if p_organization_id is null then
    raise exception 'p_organization_id is required';
  end if;
  if p_chat_session_id is null or length(trim(p_chat_session_id)) = 0 then
    raise exception 'p_chat_session_id is required';
  end if;

  select not exists (select 1 from leads where chat_session_id = p_chat_session_id) into v_is_new;

  insert into leads (
    organization_id, name, email, phone, company, source, status, score, notes, chat_session_id, last_activity_at
  )
  values (
    p_organization_id, p_name, p_email, p_phone, p_company, 'chat', p_status, p_score, p_notes, p_chat_session_id, now()
  )
  on conflict (chat_session_id) do update set
    name = excluded.name,
    email = excluded.email,
    phone = excluded.phone,
    company = excluded.company,
    status = excluded.status,
    score = excluded.score,
    notes = excluded.notes,
    last_activity_at = now()
  returning * into v_lead;

  insert into lead_activity (organization_id, lead_id, message)
  values (
    v_lead.organization_id,
    v_lead.id,
    case when v_is_new
      then 'Lead creado automáticamente desde una conversación de chat con IA.'
      else 'Información del lead actualizada.'
    end
  );

  return v_lead;
end;
$$;

revoke all on function public.upsert_chat_lead(uuid, text, text, text, text, text, text, integer, text) from public;
grant execute on function public.upsert_chat_lead(uuid, text, text, text, text, text, text, integer, text) to anon, authenticated;

-- ── form_submissions ─────────────────────────────────────────────────────
create table if not exists form_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade, -- denormalized from forms.organization_id, see note at top of file
  form_id uuid not null references forms(id) on delete cascade,
  answers jsonb not null default '[]',
  score integer not null check (score between 0 and 100),
  lead_id uuid references leads(id) on delete set null, -- safe FK: the lead already exists by this point
  submitted_at timestamptz not null default now()
);

create index if not exists form_submissions_form_id_idx on form_submissions (form_id);

alter table form_submissions enable row level security;
drop policy if exists "form_submissions_select" on form_submissions;
drop policy if exists "form_submissions_insert" on form_submissions;
drop policy if exists "form_submissions_update" on form_submissions;
drop policy if exists "form_submissions_delete" on form_submissions;
-- SELECT stays is_org_member (unchanged) — every role, including viewer,
-- can see an organization's submissions; only writing them is restricted.
create policy "form_submissions_select" on form_submissions for select using (is_org_member(organization_id));
-- Fase C: was `with check (true)` (open to anyone, anon or authenticated) —
-- a public form submission now writes here exclusively through
-- POST /api/forms/:formId/submissions (service_role, bypasses RLS
-- regardless). No UI or code path ever needs an authenticated non-editor
-- to insert a submission directly, so this now matches leads_insert's own
-- authenticated threshold — see migrations-form-submissions-rls.sql.
create policy "form_submissions_insert" on form_submissions for insert with check (
  is_org_editor(organization_id)
);
-- UPDATE/DELETE: no UI exposes editing or deleting a submission today, but
-- RLS shouldn't rely on that — same is_org_editor/is_org_admin thresholds
-- as forms above, so a viewer can't modify or delete a submission via a
-- direct API call either. WITH CHECK mirrors USING for the same
-- organization_id-reassignment reason as forms_update/leads_update.
create policy "form_submissions_update" on form_submissions for update
  using (is_org_editor(organization_id))
  with check (is_org_editor(organization_id));
create policy "form_submissions_delete" on form_submissions for delete using (is_org_admin(organization_id));

-- ── lead_activity ────────────────────────────────────────────────────────
-- The one place normalization is chosen over jsonb: this array is unbounded
-- and append-only for the life of a lead. jsonb has no efficient append —
-- every update() would otherwise rewrite the entire history. A real table
-- lets new entries be genuine INSERTs.
create table if not exists lead_activity (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade, -- denormalized from leads.organization_id, see note at top of file
  lead_id uuid not null references leads(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists lead_activity_lead_id_created_at_idx
  on lead_activity (lead_id, created_at desc);

alter table lead_activity enable row level security;
drop policy if exists "lead_activity_select" on lead_activity;
drop policy if exists "lead_activity_insert" on lead_activity;
drop policy if exists "lead_activity_update" on lead_activity;
drop policy if exists "lead_activity_delete" on lead_activity;
create policy "lead_activity_select" on lead_activity for select using (is_org_member(organization_id));
-- Fase C: was `with check (true)` (open to anyone). The public form flow's
-- activity entry is now written server-side via service_role (bypasses RLS
-- regardless) by POST /api/forms/:formId/submissions; the public chat's
-- activity entry is written by the upsert_chat_lead() RPC (SECURITY
-- DEFINER, also bypasses RLS). The authenticated dashboard's create/update
-- flows (insertActivity() in lead-supabase-repository.ts) are the only
-- remaining caller this policy needs to allow — see
-- migrations-form-submissions-rls.sql.
create policy "lead_activity_insert" on lead_activity for insert with check (
  is_org_editor(organization_id)
);
create policy "lead_activity_update" on lead_activity for update using (is_org_member(organization_id));
create policy "lead_activity_delete" on lead_activity for delete using (is_org_member(organization_id));

-- ── chat_configuration ───────────────────────────────────────────────────
-- Singleton-per-organization config: one row per organization_id (unique
-- below), replacing the pre-Phase-8 org_slug-keyed singleton. /c/:orgSlug
-- resolves organizations.slug -> organizations.id -> this table's
-- organization_id — see entities/chat/chat-config-supabase-repository.ts.
create table if not exists chat_configuration (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  assistant_name text not null,
  welcome_message text not null,
  agency_description text not null default '',
  services_offered text not null default '',
  tone text not null check (tone in ('professional', 'friendly', 'concise', 'consultative')),
  language text not null default 'Español',
  questions_to_collect text[] not null default '{}',
  criteria jsonb not null default '[]',
  min_qualified_score integer not null default 70 check (min_qualified_score between 0 and 100),
  additional_instructions text,
  is_active boolean not null default true,
  created_by uuid, -- always NULL until a later phase wires it to auth.uid() on insert
  updated_at timestamptz not null default now()
);

alter table chat_configuration enable row level security;
drop policy if exists "chat_configuration_select" on chat_configuration;
drop policy if exists "chat_configuration_insert" on chat_configuration;
drop policy if exists "chat_configuration_update" on chat_configuration;
drop policy if exists "chat_configuration_delete" on chat_configuration;
-- Public on purpose: /c/:orgSlug is a no-login public chat page — see the
-- multi-tenancy note at the top of this file. SELECT is intentionally left
-- as-is (public) — do not gate it by role/membership, it would break the
-- public chat page's config lookup.
create policy "chat_configuration_select" on chat_configuration for select using (true);
-- INSERT/UPDATE: owner/admin/member (is_org_editor) — a viewer can read the
-- chat assistant's configuration (via the public SELECT above, same as
-- everyone) but not save changes to it, in /chat-settings or via a direct
-- API call. WITH CHECK mirrors USING on the update policy for the same
-- organization_id-reassignment reason as forms_update/leads_update.
create policy "chat_configuration_insert" on chat_configuration for insert with check (is_org_editor(organization_id));
create policy "chat_configuration_update" on chat_configuration for update
  using (is_org_editor(organization_id))
  with check (is_org_editor(organization_id));
-- DELETE: owner/admin only, same threshold as forms_delete/leads_delete —
-- no UI exposes this today (ChatConfigRepository has no delete method), but
-- RLS shouldn't rely on that.
create policy "chat_configuration_delete" on chat_configuration for delete using (is_org_admin(organization_id));

-- ── chat_sessions / chat_messages ────────────────────────────────────────
-- The "display copy" of a public chat conversation (/c/:orgSlug), moved out
-- of browser localStorage (see entities/chat/chat-session-repository.ts's
-- history) because a per-browser store meant an anonymous visitor's
-- conversation was only ever visible in the browser that ran it —
-- /conversations (an authenticated, cross-device dashboard page) could never
-- see it. Unrelated to server/data/sessions.json, which stays exactly as-is:
-- that file is the backend's own store of conversation history sent to
-- Claude, never read by the frontend directly.
--
-- Unlike every other public-write table in this file (leads, form_submissions,
-- lead_activity — all `insert with check (true)`), these two tables have NO
-- insert/update policy for ANY role, anon or authenticated. Every write goes
-- through one of the four SECURITY DEFINER functions below, each with its
-- own explicit, narrow validation (see each function's comment). This is a
-- deliberately stricter pattern than the rest of the file: a chat transcript
-- is PII, so RLS never grants a public SELECT here either (contrast with
-- forms/chat_configuration's public read for their own no-login pages).
--
-- chat_sessions.id deliberately has NO default — it's always the same UUID
-- the Express backend already minted in createSession() (see
-- server/src/repositories/session-repository.ts) and returned to the
-- frontend as `sessionId`, so leads.chat_session_id keeps referring to the
-- same conversation across both stores.
create table if not exists chat_sessions (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  org_slug text not null,
  assistant_name text not null,
  qualification jsonb,
  lead_id uuid references leads(id) on delete set null, -- safe FK: the lead already exists by the time a session links to it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table chat_sessions enable row level security;
drop policy if exists "chat_sessions_select" on chat_sessions;
drop policy if exists "chat_sessions_delete" on chat_sessions;
create policy "chat_sessions_select" on chat_sessions for select using (is_org_member(organization_id));
create policy "chat_sessions_delete" on chat_sessions for delete using (is_org_member(organization_id));

-- Normalized, not a jsonb array on chat_sessions — same append-only
-- reasoning as lead_activity above.
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade, -- denormalized from chat_sessions.organization_id, same reasoning as lead_activity.organization_id
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_id_created_at_idx on chat_messages (session_id, created_at);

alter table chat_messages enable row level security;
drop policy if exists "chat_messages_select" on chat_messages;
drop policy if exists "chat_messages_delete" on chat_messages;
create policy "chat_messages_select" on chat_messages for select using (is_org_member(organization_id));
create policy "chat_messages_delete" on chat_messages for delete using (is_org_member(organization_id));

-- ── RPC: create_public_chat_session ──────────────────────────────────────
-- The only way an anonymous visitor can create a chat_sessions row.
-- organization_id/org_slug are cross-validated against the SAME
-- organizations row (not checked independently) and chat_configuration.is_active
-- is re-verified server-side rather than trusted from the client. The row
-- actually inserted uses v_org_id (the validated result), never the raw
-- p_organization_id parameter. assistant_name/welcome_message are read from
-- chat_configuration here, not accepted as parameters — the client never
-- gets to choose what gets stored for either.
create or replace function public.create_public_chat_session(
  p_session_id uuid,
  p_organization_id uuid,
  p_org_slug text
)
returns chat_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_assistant_name text;
  v_welcome_message text;
  v_is_active boolean;
  v_session chat_sessions;
begin
  if p_session_id is null then
    raise exception 'p_session_id is required';
  end if;
  if p_organization_id is null or p_org_slug is null then
    raise exception 'p_organization_id and p_org_slug are required';
  end if;

  select o.id, cc.assistant_name, cc.welcome_message, cc.is_active
    into v_org_id, v_assistant_name, v_welcome_message, v_is_active
  from organizations o
  join chat_configuration cc on cc.organization_id = o.id
  where o.id = p_organization_id and o.slug = p_org_slug;

  if v_org_id is null then
    raise exception 'La organización o el enlace del chat no son válidos.';
  end if;
  if v_is_active is distinct from true then
    raise exception 'El chat público de esta organización no está activo.';
  end if;

  insert into chat_sessions (id, organization_id, org_slug, assistant_name)
  values (p_session_id, v_org_id, p_org_slug, v_assistant_name)
  returning * into v_session;

  insert into chat_messages (organization_id, session_id, role, content)
  values (v_org_id, p_session_id, 'assistant', v_welcome_message);

  return v_session;
end;
$$;

revoke all on function public.create_public_chat_session(uuid, uuid, text) from public;
revoke all on function public.create_public_chat_session(uuid, uuid, text) from anon, authenticated;
grant execute on function public.create_public_chat_session(uuid, uuid, text) to anon, authenticated;

-- ── RPC: append_chat_message ─────────────────────────────────────────────
-- The only way to insert into chat_messages for an anonymous visitor.
-- organization_id is never a parameter here — it's always derived from the
-- chat_sessions row found by p_session_id, so a caller can never write a
-- message tagged with a different organization than its own session's.
create or replace function public.append_chat_message(
  p_session_id uuid,
  p_role text,
  p_content text
)
returns chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_message chat_messages;
begin
  if p_session_id is null then
    raise exception 'p_session_id is required';
  end if;
  if p_role not in ('user', 'assistant') then
    raise exception 'p_role must be ''user'' or ''assistant''';
  end if;
  if p_content is null or length(trim(p_content)) = 0 then
    raise exception 'p_content is required';
  end if;

  select cs.organization_id into v_organization_id
  from chat_sessions cs
  join organizations o on o.id = cs.organization_id
  where cs.id = p_session_id;

  if v_organization_id is null then
    raise exception 'La sesión de chat indicada no existe.';
  end if;

  insert into chat_messages (organization_id, session_id, role, content)
  values (v_organization_id, p_session_id, p_role, p_content)
  returning * into v_message;

  update chat_sessions set updated_at = now() where id = p_session_id;

  return v_message;
end;
$$;

revoke all on function public.append_chat_message(uuid, text, text) from public;
revoke all on function public.append_chat_message(uuid, text, text) from anon, authenticated;
grant execute on function public.append_chat_message(uuid, text, text) to anon, authenticated;

-- ── RPC: set_chat_session_qualification ──────────────────────────────────
-- Single-row UPDATE keyed only by p_session_id (the server-minted UUID) —
-- no other filter is client-controllable.
create or replace function public.set_chat_session_qualification(
  p_session_id uuid,
  p_qualification jsonb
)
returns chat_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session chat_sessions;
begin
  if p_session_id is null then
    raise exception 'p_session_id is required';
  end if;

  update chat_sessions
  set qualification = p_qualification, updated_at = now()
  where id = p_session_id
  returning * into v_session;

  if v_session.id is null then
    raise exception 'La sesión de chat indicada no existe.';
  end if;

  return v_session;
end;
$$;

revoke all on function public.set_chat_session_qualification(uuid, jsonb) from public;
revoke all on function public.set_chat_session_qualification(uuid, jsonb) from anon, authenticated;
grant execute on function public.set_chat_session_qualification(uuid, jsonb) to anon, authenticated;

-- ── RPC: link_chat_session_lead ───────────────────────────────────────────
-- Verifies the lead exists AND belongs to the SAME organization as the
-- session before linking — a session can never be linked to another
-- organization's lead.
create or replace function public.link_chat_session_lead(
  p_session_id uuid,
  p_lead_id uuid
)
returns chat_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_session chat_sessions;
begin
  if p_session_id is null then
    raise exception 'p_session_id is required';
  end if;
  if p_lead_id is null then
    raise exception 'p_lead_id is required';
  end if;

  select organization_id into v_organization_id from chat_sessions where id = p_session_id;
  if v_organization_id is null then
    raise exception 'La sesión de chat indicada no existe.';
  end if;

  if not exists (
    select 1 from leads where id = p_lead_id and organization_id = v_organization_id
  ) then
    raise exception 'El lead indicado no existe o pertenece a otra organización.';
  end if;

  update chat_sessions
  set lead_id = p_lead_id, updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

revoke all on function public.link_chat_session_lead(uuid, uuid) from public;
revoke all on function public.link_chat_session_lead(uuid, uuid) from anon, authenticated;
grant execute on function public.link_chat_session_lead(uuid, uuid) to anon, authenticated;

-- ── Aprovisionamiento de la organización personal ─────────────────────────
-- Mirrors supabase/migrations-org-bootstrap.sql exactly (sin verificación ni
-- reversión) — ver ese archivo para el razonamiento completo. Crea en UNA
-- transacción, serializada por usuario e idempotente, la organización
-- personal + membresía owner + team_member del primer acceso. La llama
-- OrganizationProvider.tsx (vía organization-supabase-repository.ts) en lugar
-- de las antiguas inserciones separadas desde el navegador.
create or replace function public.bootstrap_personal_organization()
returns table (organization_id uuid, organization_slug text, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- Las columnas de salida (organization_id, …) se llaman igual que columnas
-- reales: dentro de las sentencias SQL, el nombre se refiere a la COLUMNA.
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_email text := nullif(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), '');
  v_base_name text;
  v_org_name text;
  v_base_slug text;
  v_slug text;
  v_org_id uuid;
  v_existing_id uuid;
  v_existing_slug text;
  v_attempt integer;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  -- Serializa a ESTE usuario hasta el final de la transacción. Una segunda
  -- llamada concurrente espera aquí y, al continuar, ve ya confirmada la
  -- membresía de la primera (READ COMMITTED: nuevo snapshot por sentencia).
  perform pg_advisory_xact_lock(hashtext('bootstrap_personal_organization'), hashtext(v_uid::text));

  select m.organization_id, o.slug
    into v_existing_id, v_existing_slug
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = v_uid
  order by m.created_at asc, m.organization_id asc
  limit 1;

  if v_existing_id is not null then
    return query select v_existing_id, v_existing_slug, false;
    return;
  end if;

  -- Mismo criterio que deriveOrganizationName() en el frontend: full_name,
  -- si no la parte local del email, si no un texto genérico.
  v_base_name := coalesce(
    nullif(trim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
    nullif(split_part(coalesce(v_email, ''), '@', 1), ''),
    'Mi organización'
  );
  v_base_name := left(v_base_name, 120);
  v_org_name := 'Organización de ' || v_base_name;

  -- Slug equivalente al slugify() del frontend: minúsculas, sin acentos,
  -- solo [a-z0-9-]. Reintenta con sufijo aleatorio si el slug ya existe.
  v_base_slug := regexp_replace(
    translate(lower(v_org_name), 'áàäâãåéèëêíìïîóòöôõúùüûñç', 'aaaaaaeeeeiiiiooooouuuunc'),
    '[^a-z0-9]+', '-', 'g'
  );
  v_base_slug := trim(both '-' from v_base_slug);
  if v_base_slug = '' then
    v_base_slug := 'org';
  end if;

  for v_attempt in 0..9 loop
    v_slug := case when v_attempt = 0 then v_base_slug
                   else v_base_slug || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4) end;
    insert into public.organizations (name, slug, created_by)
    values (v_org_name, v_slug, v_uid)
    on conflict (slug) do nothing
    returning id into v_org_id;
    exit when v_org_id is not null;
  end loop;

  if v_org_id is null then
    raise exception 'ORG_SLUG_UNAVAILABLE';
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org_id, v_uid, 'owner');

  -- team_member del owner para que "Persona asignada" no esté vacío. Sin
  -- email en el JWT (p. ej. acceso por teléfono) no se crea, igual que antes.
  if v_email is not null then
    insert into public.team_members (organization_id, name, email, role)
    values (v_org_id, v_base_name, v_email, 'owner')
    on conflict (organization_id, email) do nothing;
  end if;

  return query select v_org_id, v_slug, true;
end;
$$;

-- Solo usuarios autenticados. anon y PUBLIC no pueden ejecutarla (Supabase
-- concede EXECUTE a anon/authenticated por defecto: se revoca explícitamente).
revoke all on function public.bootstrap_personal_organization() from public, anon, authenticated;
grant execute on function public.bootstrap_personal_organization() to authenticated;

-- ── Webhooks (first real integration) ────────────────────────────────────
-- See supabase/migrations-webhooks.sql for the full design rationale (why
-- a trigger + outbox instead of pg_net, why no SELECT policy at all on
-- webhook_configurations, why the trigger must be SECURITY DEFINER). This
-- section mirrors that file exactly for a fresh install.

create table if not exists webhook_configurations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  url text not null,
  is_active boolean not null default false,
  -- Generated server-side by the Express backend, never sent back to the
  -- browser after creation — see the "no select policy" note below.
  secret text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Nullable + ON DELETE SET NULL (not CASCADE) — deleting the
  -- configuration or the lead must not erase delivery history/audit trail;
  -- `payload` already holds a full snapshot. See
  -- server/src/services/webhook-worker.ts for how a null
  -- webhook_configuration_id on an in-flight delivery is handled.
  webhook_configuration_id uuid references webhook_configurations(id) on delete set null,
  event_type text not null check (event_type in ('lead.created')),
  lead_id uuid references leads(id) on delete set null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  locked_at timestamptz, -- processing lease, see claim_webhook_deliveries() below
  last_attempted_at timestamptz,
  last_error text,
  response_status integer,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists webhook_deliveries_status_next_attempt_idx
  on webhook_deliveries (status, next_attempt_at);
create index if not exists webhook_deliveries_organization_id_idx
  on webhook_deliveries (organization_id);
create index if not exists webhook_deliveries_lead_id_idx
  on webhook_deliveries (lead_id);

alter table webhook_configurations enable row level security;
drop policy if exists "webhook_configurations_insert_admins" on webhook_configurations;
drop policy if exists "webhook_configurations_update_admins" on webhook_configurations;
drop policy if exists "webhook_configurations_delete_admins" on webhook_configurations;
-- Deliberately NO select policy for anon/authenticated — the only reader is
-- the Express backend via the service_role key, which strips `secret`
-- before ever building a JSON response. See
-- server/src/repositories/webhook-repository.ts's toPublicConfig().
create policy "webhook_configurations_insert_admins" on webhook_configurations for insert
  with check (is_org_admin(organization_id));
create policy "webhook_configurations_update_admins" on webhook_configurations for update
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));
create policy "webhook_configurations_delete_admins" on webhook_configurations for delete
  using (is_org_admin(organization_id));

alter table webhook_deliveries enable row level security;
drop policy if exists "webhook_deliveries_select" on webhook_deliveries;
create policy "webhook_deliveries_select" on webhook_deliveries for select
  using (is_org_member(organization_id));
-- Deliberately no insert/update/delete policy for anon/authenticated — only
-- the SECURITY DEFINER trigger below and the backend's service_role client
-- ever write this table.

-- IMPORTANT — wrapped in BEGIN...EXCEPTION WHEN OTHERS: an AFTER INSERT
-- trigger runs inside the same transaction as the triggering INSERT, so an
-- unhandled exception here would roll back the lead INSERT too. This
-- project's priority requirement is that a webhook-subsystem failure must
-- never prevent a lead from being saved — see migrations-webhooks.sql's
-- full comment on this function for the complete reasoning (why WHEN
-- OTHERS is intentional here, what RAISE WARNING logs and why it never
-- includes secret/payload, and why this can't mask a leads-INSERT failure
-- since that already succeeded before this trigger fires).
create or replace function notify_lead_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_config webhook_configurations%rowtype;
  v_delivery_id uuid;
  v_payload jsonb;
begin
  begin
    select * into v_config
    from webhook_configurations
    where organization_id = NEW.organization_id and is_active = true
    limit 1;

    if v_config.id is not null then
      v_delivery_id := gen_random_uuid();

      v_payload := jsonb_build_object(
        'event', 'lead.created',
        'event_id', v_delivery_id,
        'timestamp', now(),
        'organization_id', NEW.organization_id,
        'lead', jsonb_build_object(
          'id', NEW.id,
          'name', NEW.name,
          'email', NEW.email,
          'phone', NEW.phone,
          'company', NEW.company,
          'position', NEW.position,
          'source', NEW.source,
          'status', NEW.status,
          'score', NEW.score,
          'estimated_budget', NEW.estimated_budget,
          'notes', NEW.notes,
          'form_id', NEW.form_id,
          'submission_id', NEW.submission_id,
          'chat_session_id', NEW.chat_session_id,
          'created_at', NEW.created_at
        )
      );

      insert into webhook_deliveries (
        id, organization_id, webhook_configuration_id, event_type, lead_id, payload, status
      ) values (
        v_delivery_id, NEW.organization_id, v_config.id, 'lead.created', NEW.id, v_payload, 'pending'
      );
    end if;
  exception
    when others then
      raise warning 'notify_lead_created: failed to enqueue webhook delivery for lead % (org %): % (SQLSTATE %)',
        NEW.id, NEW.organization_id, SQLERRM, SQLSTATE;
  end;

  return NEW;
end;
$$;

-- See migrations-webhooks.sql's comment on this same line — hygiene, not a
-- functional requirement (trigger firing doesn't need EXECUTE, and
-- PostgreSQL refuses to call a `returns trigger` function directly either
-- way).
revoke execute on function notify_lead_created() from public;

drop trigger if exists leads_notify_webhook on leads;
create trigger leads_notify_webhook
  after insert on leads
  for each row
  execute function notify_lead_created();

-- Atomic worker claim — see migrations-webhooks.sql for why this must be a
-- single UPDATE ... FOR UPDATE SKIP LOCKED statement rather than a select-
-- then-update from the backend.
create or replace function claim_webhook_deliveries(p_limit integer default 10, p_lease_seconds integer default 120)
returns setof webhook_deliveries
language sql
as $$
  update webhook_deliveries
  set status = 'processing',
      locked_at = now(),
      last_attempted_at = now(),
      attempts = attempts + 1
  where id in (
    select id from webhook_deliveries
    where (
      status = 'pending'
      and (next_attempt_at is null or next_attempt_at <= now())
    ) or (
      status = 'processing'
      and locked_at < now() - make_interval(secs => p_lease_seconds)
    )
    order by created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
$$;

revoke all on function claim_webhook_deliveries(integer, integer) from public;
grant execute on function claim_webhook_deliveries(integer, integer) to service_role;

-- ── HubSpot CRM integration — Fase 1: base de datos + RLS ──────────────────
-- Mirrors supabase/migrations-hubspot.sql exactly — see that file for the
-- full reasoning behind every choice below (composite FK for multi-tenant
-- integrity, hub_portal_id's NOT NULL, the zero-SELECT-RLS pattern on the
-- sensitive table, ON DELETE CASCADE vs SET NULL). No OAuth flow, no
-- HubSpot API calls, no sync logic yet — later phases. Purely additive:
-- does not alter any Webhooks table/policy/trigger/function above, and the
-- one change to a preexisting table (the unique constraint added to
-- `leads` just below) does not touch any existing constraint on it,
-- including the one webhook_deliveries.lead_id already relies on.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_id_organization_id_key' and conrelid = 'leads'::regclass
  ) then
    alter table leads
      add constraint leads_id_organization_id_key unique (id, organization_id);
  end if;
end $$;

create table if not exists hubspot_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  hub_portal_id text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  access_token_expires_at timestamptz not null,
  scopes text not null,
  needs_reauth boolean not null default false,
  connected_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table hubspot_connections enable row level security;
drop policy if exists "hubspot_connections_insert_admins" on hubspot_connections;
drop policy if exists "hubspot_connections_update_admins" on hubspot_connections;
drop policy if exists "hubspot_connections_delete_admins" on hubspot_connections;

create policy "hubspot_connections_insert_admins" on hubspot_connections for insert
  with check (is_org_admin(organization_id));
create policy "hubspot_connections_update_admins" on hubspot_connections for update
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));
create policy "hubspot_connections_delete_admins" on hubspot_connections for delete
  using (is_org_admin(organization_id));

create table if not exists hubspot_contact_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null,
  foreign key (lead_id, organization_id) references leads (id, organization_id) on delete cascade,
  hubspot_contact_id text not null,
  last_synced_at timestamptz not null default now(),
  last_sync_status text not null check (last_sync_status in ('synced', 'failed')),
  last_sync_error text,
  created_at timestamptz not null default now(),
  unique (organization_id, lead_id)
);

create index if not exists hubspot_contact_links_organization_id_idx
  on hubspot_contact_links (organization_id);

alter table hubspot_contact_links enable row level security;
drop policy if exists "hubspot_contact_links_select" on hubspot_contact_links;

create policy "hubspot_contact_links_select" on hubspot_contact_links for select
  using (is_org_member(organization_id));

-- ── HubSpot CRM integration — Fase 2: estado (`state`) de OAuth ────────────
-- Mirrors supabase/migrations-hubspot-oauth-state.sql exactly — see that
-- file for the full reasoning (why a table and not an in-memory Map, given
-- Railway can restart the backend process between /oauth/start and
-- /oauth/callback). Purely additive, no changes to any Webhooks or
-- Fase 1 HubSpot table/policy above.
create table if not exists hubspot_oauth_states (
  state text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists hubspot_oauth_states_expires_at_idx
  on hubspot_oauth_states (expires_at);

alter table hubspot_oauth_states enable row level security;
-- Deliberately zero policies — see migrations-hubspot-oauth-state.sql.

-- ── Fase B: usage_events (medición real de consumo de Anthropic) ──────────
-- Mirrors supabase/migrations-usage-events.sql exactly — see that file for
-- the full reasoning (why session_id is uuid with no FK to chat_sessions,
-- why there's no INSERT/UPDATE/DELETE policy for anon/authenticated).
-- Purely additive, no changes to any table/policy above.
create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  session_id uuid not null,
  purpose text not null check (purpose in ('reply', 'extraction')),
  model text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  created_at timestamptz not null default now()
);

create index if not exists usage_events_organization_id_created_at_idx
  on usage_events (organization_id, created_at);
create index if not exists usage_events_session_id_idx
  on usage_events (session_id);

alter table usage_events enable row level security;
create policy "usage_events_select" on usage_events for select
  using (is_org_member(organization_id));
-- Deliberately no insert/update/delete policy for anon/authenticated —
-- only the Express backend (service_role) writes this table.

-- ── Cuotas mensuales por organización ───────────────────────────────────
-- Mirrors supabase/migrations-usage-quotas.sql exactly (sin las consultas de
-- verificación ni el bloque de reversión) — ver ese archivo para el
-- razonamiento completo: atomicidad, idempotencia, bloqueo por organización,
-- atribución al cambiar de mes, SECURITY INVOKER y privilegios. El backend
-- las usa SOLO con CHAT_QUOTAS_ENABLED=true (apagado por defecto); el
-- frontend no las usa. Ver CLAUDE.md, "Monthly chat quotas". En un proyecto
-- nuevo el backfill de organization_quotas no inserta filas (aún no hay
-- organizaciones): cada organización que se cree después recibe su fila en
-- modo 'shadow' mediante el trigger de la sección 13. Una organización sin
-- fila ("unconfigured") nunca tiene acceso ilimitado: reserve_chat_usage()
-- la deniega.

-- ── 1. plans: catálogo de planes (sin precios) ─────────────────────────────
-- Límites NULL = "no configurado". En modo 'enforce', un límite mensual NULL
-- DENIEGA (falla cerrado). hourly_message_cap NULL = sin tope por hora.
create table if not exists public.plans (
  code text primary key check (code ~ '^[a-z0-9_]{2,40}$'),
  display_name text not null,
  monthly_conversation_limit integer check (monthly_conversation_limit >= 0),
  monthly_budget_micros bigint check (monthly_budget_micros >= 0),
  -- Límite TÉCNICO anti-ráfaga (mensajes reservados por organización en la
  -- última hora). Se guarda aquí por comodidad, no es un atributo comercial.
  hourly_message_cap integer check (hourly_message_cap > 0),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.plans (code, display_name) values
  ('pilot', 'Piloto'),
  ('starter', 'Starter'),
  ('professional', 'Professional'),
  ('business', 'Business')
on conflict (code) do nothing;

-- ── 2. organization_quotas: plan y modo de cada organización ───────────────
create table if not exists public.organization_quotas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plan_code text references public.plans(code) on update cascade on delete restrict,
  conversation_limit_override integer check (conversation_limit_override >= 0),
  budget_micros_override bigint check (budget_micros_override >= 0),
  hourly_message_cap_override integer check (hourly_message_cap_override > 0),
  status text not null default 'active' check (status in ('active', 'suspended')),
  enforcement_mode text not null default 'off' check (enforcement_mode in ('off', 'shadow', 'enforce')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Compatibilidad: toda organización existente queda en 'off' (sin efecto).
-- Solo en la PRIMERA aplicación (tabla aún vacía): si este script se
-- re-ejecuta más adelante, una organización que hubiera quedado sin fila
-- (p. ej. porque falló el trigger de la sección 13) debe seguir DENEGADA,
-- no recibir 'off' = acceso ilimitado por accidente.
insert into public.organization_quotas (organization_id, plan_code, enforcement_mode)
select id, 'pilot', 'off' from public.organizations
where not exists (select 1 from public.organization_quotas)
on conflict (organization_id) do nothing;

-- ── 3. model_prices: precio por modelo, cargado a mano ─────────────────────
-- Vacía a propósito. Micro-USD por MILLÓN de tokens (p. ej. US$1/MTok =
-- 1000000). Valores tomados SOLO de la página oficial de precios de
-- Anthropic; ver el procedimiento en CLAUDE.md ("Monthly chat quotas") y las
-- consultas de control en monitoring-usage-quotas.sql.
create table if not exists public.model_prices (
  model text primary key check (length(trim(model)) > 0),
  input_micros_per_mtok bigint not null check (input_micros_per_mtok >= 0),
  output_micros_per_mtok bigint not null check (output_micros_per_mtok >= 0),
  -- Procedencia (obligatoria, ver restricciones abajo): de dónde salió el
  -- precio y qué día se comprobó. Nunca un valor sin fuente.
  source_url text,
  verified_on date,
  updated_at timestamptz not null default now()
);

-- Re-ejecución sobre una tabla creada por una versión anterior de este
-- script: añade las columnas de procedencia si faltan.
alter table public.model_prices add column if not exists source_url text;
alter table public.model_prices add column if not exists verified_on date;

-- Restricciones de sanidad (con nombre propio, recreables al re-ejecutar).
-- Si una fila existente las incumple, el script FALLA a propósito: hay que
-- corregir esa fila (con su fuente oficial) antes de continuar.
--  * Identificador exacto como lo usa la API: minúsculas, sin espacios.
--    Rechaza 'Claude-Opus-4-8', ' claude-opus-4-8', 'claude opus'.
--  * Rango plausible por MILLÓN de tokens: US$0,01 a US$1.000/MTok. Bloquea
--    errores de unidades (un precio cargado "en USD" o "por token", p. ej.
--    5, haría el costo ≈ 0 y el presupuesto nunca se agotaría).
--  * Procedencia: URL https de un dominio de Anthropic (anthropic.com o
--    claude.com) y fecha de verificación.
alter table public.model_prices drop constraint if exists model_prices_model_format_check;
alter table public.model_prices add constraint model_prices_model_format_check
  check (model ~ '^[a-z0-9][a-z0-9._-]{1,99}$');
alter table public.model_prices drop constraint if exists model_prices_input_range_check;
alter table public.model_prices add constraint model_prices_input_range_check
  check (input_micros_per_mtok between 10000 and 1000000000);
alter table public.model_prices drop constraint if exists model_prices_output_range_check;
alter table public.model_prices add constraint model_prices_output_range_check
  check (output_micros_per_mtok between 10000 and 1000000000);
alter table public.model_prices drop constraint if exists model_prices_source_url_check;
alter table public.model_prices add constraint model_prices_source_url_check
  check (source_url is not null and source_url ~ '^https://([a-z0-9-]+\.)*(anthropic\.com|claude\.com)(/|$)');
alter table public.model_prices drop constraint if exists model_prices_verified_on_check;
alter table public.model_prices add constraint model_prices_verified_on_check
  check (verified_on is not null);

-- ── 4. usage_periods: contadores por organización y mes (UTC) ──────────────
create table if not exists public.usage_periods (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_start date not null check (extract(day from period_start) = 1),
  conversations_used integer not null default 0 check (conversations_used >= 0),
  messages_used integer not null default 0 check (messages_used >= 0),
  -- Suma de estimated_micros de reservas aún 'reserved' de este periodo.
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  -- Suma de actual_micros de reservas ya liquidadas de este periodo.
  settled_micros bigint not null default 0 check (settled_micros >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, period_start)
);

-- ── 5. usage_conversations: cada sesión cuenta una sola vez ────────────────
create table if not exists public.usage_conversations (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Mismo id que genera el backend Express (randomUUID()); sin FK hacia
  -- chat_sessions por la misma razón documentada en usage_events.
  session_id uuid not null,
  period_start date not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, session_id)
);

-- ── 6. usage_reservations: ledger, una fila por mensaje ────────────────────
create table if not exists public.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_id uuid not null,
  period_start date not null,
  enforcement_mode text not null check (enforcement_mode in ('shadow', 'enforce')),
  model text not null,
  estimated_input_tokens integer not null check (estimated_input_tokens >= 0),
  max_output_tokens integer not null check (max_output_tokens >= 0),
  -- Copia de los precios usados al reservar (auditable aunque cambien después).
  input_micros_per_mtok bigint not null check (input_micros_per_mtok >= 0),
  output_micros_per_mtok bigint not null check (output_micros_per_mtok >= 0),
  estimated_micros bigint not null check (estimated_micros >= 0),
  -- Solo en modo 'shadow': la razón por la que 'enforce' habría denegado.
  shadow_would_deny text,
  status text not null default 'reserved' check (status in ('reserved', 'settled')),
  actual_input_tokens integer check (actual_input_tokens >= 0),
  actual_output_tokens integer check (actual_output_tokens >= 0),
  actual_model text,
  actual_micros bigint check (actual_micros >= 0),
  -- 'actual': tokens y precio reales. 'estimated': uso real desconocido,
  -- se conserva la estimación. 'reservation_price': tokens reales pero el
  -- modelo informado no tiene precio — se usa el mayor entre la estimación
  -- y los tokens reales a precio de la reserva. 'expired': nadie la liquidó
  -- (caída del proceso, fallo de liquidación); la cerró
  -- expire_stale_chat_reservations() por su estimación completa.
  settlement_basis text check (settlement_basis in ('actual', 'estimated', 'reservation_price', 'expired')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (
    (status = 'reserved' and actual_micros is null and settled_at is null and settlement_basis is null)
    or (status = 'settled' and actual_micros is not null and settled_at is not null and settlement_basis is not null)
  )
);

create index if not exists usage_reservations_org_created_at_idx
  on public.usage_reservations (organization_id, created_at);
create index if not exists usage_reservations_org_period_status_idx
  on public.usage_reservations (organization_id, period_start, status);

-- Re-ejecución sobre una tabla creada por una versión anterior de este
-- script (sin 'expired'): `create table if not exists` no cambia un CHECK
-- existente, así que se recrea con su nombre generado por Postgres.
alter table public.usage_reservations drop constraint if exists usage_reservations_settlement_basis_check;
alter table public.usage_reservations add constraint usage_reservations_settlement_basis_check
  check (settlement_basis in ('actual', 'estimated', 'reservation_price', 'expired'));

-- Solo las reservas aún abiertas: búsqueda barata de reservas abandonadas
-- (expire_stale_chat_reservations) aunque la tabla crezca.
create index if not exists usage_reservations_reserved_created_at_idx
  on public.usage_reservations (created_at)
  where status = 'reserved';

-- ── 7. RLS y privilegios de tabla ──────────────────────────────────────────
-- Cero políticas: solo service_role (que omite RLS) lee o escribe. Una
-- futura pantalla de consumo (Fase 5) añadirá una vista/RPC de lectura
-- acotada, después de decidir qué datos ve el cliente.
alter table public.plans enable row level security;
alter table public.organization_quotas enable row level security;
alter table public.model_prices enable row level security;
alter table public.usage_periods enable row level security;
alter table public.usage_conversations enable row level security;
alter table public.usage_reservations enable row level security;

revoke all on table public.plans from anon, authenticated;
revoke all on table public.organization_quotas from anon, authenticated;
revoke all on table public.model_prices from anon, authenticated;
revoke all on table public.usage_periods from anon, authenticated;
revoke all on table public.usage_conversations from anon, authenticated;
revoke all on table public.usage_reservations from anon, authenticated;

grant select, insert, update, delete on table public.plans to service_role;
grant select, insert, update, delete on table public.organization_quotas to service_role;
grant select, insert, update, delete on table public.model_prices to service_role;
grant select, insert, update, delete on table public.usage_periods to service_role;
grant select, insert, update, delete on table public.usage_conversations to service_role;
grant select, insert, update, delete on table public.usage_reservations to service_role;

-- ── 8. quota_cost_micros(): conversión tokens → micro-USD ──────────────────
-- Redondea hacia arriba (conservador). Aritmética numeric, sin floats.
create or replace function public.quota_cost_micros(
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_input_micros_per_mtok bigint,
  p_output_micros_per_mtok bigint
)
returns bigint
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select ceil(
    (p_input_tokens::numeric * p_input_micros_per_mtok
      + p_output_tokens::numeric * p_output_micros_per_mtok) / 1000000
  )::bigint;
$$;

-- ── 9. reserve_chat_usage() ────────────────────────────────────────────────
-- Devuelve jsonb: {allowed, mode, reservation_id, reason, replayed}.
--   mode: 'unconfigured' | 'off' | 'shadow' | 'enforce'
--   reason (denegación en 'enforce', o "habría denegado" en 'shadow'):
--     'suspended' | 'limit_not_configured' | 'hourly_cap_reached'
--     | 'conversation_limit_reached' | 'budget_exhausted' | 'model_price_missing'
--   'unconfigured' (organización sin fila) siempre deniega, con reason
--   'quota_not_configured', sin escribir nada.
-- Lanza excepción (aborta todo) ante argumentos inválidos o un request_id
-- reutilizado para otra organización/sesión.
create or replace function public.reserve_chat_usage(
  p_request_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_model text,
  p_estimated_input_tokens integer,
  p_max_output_tokens integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
-- Por debajo del timeout del backend (3 s, quota-repository.ts): si el
-- bloqueo de la organización no llega a tiempo, la transacción aborta aquí
-- en vez de confirmarse después de que el backend ya se rindió (lo que
-- dejaría una reserva sin ninguna llamada asociada).
set lock_timeout = '2s'
as $$
declare
  v_period date := date_trunc('month', now() at time zone 'utc')::date;
  v_quota public.organization_quotas%rowtype;
  v_plan public.plans%rowtype;
  v_existing public.usage_reservations%rowtype;
  v_price public.model_prices%rowtype;
  v_usage public.usage_periods%rowtype;
  v_conversation_limit integer;
  v_budget bigint;
  v_hourly_cap integer;
  v_is_new_conversation boolean;
  v_recent_count integer;
  v_estimated bigint;
  v_deny text;
  v_reservation_id uuid;
begin
  if p_request_id is null or p_organization_id is null or p_session_id is null
     or p_model is null or length(trim(p_model)) = 0
     or p_estimated_input_tokens is null or p_estimated_input_tokens < 0
     or p_max_output_tokens is null or p_max_output_tokens < 0 then
    raise exception 'QUOTA_INVALID_ARGUMENT';
  end if;

  -- Bloqueo por organización: serializa solo a esta organización.
  select * into v_quota
  from public.organization_quotas
  where organization_id = p_organization_id
  for update;

  -- Idempotencia: un reintento devuelve la reserva original, sin cobrar.
  select * into v_existing
  from public.usage_reservations
  where request_id = p_request_id;

  if found then
    if v_existing.organization_id <> p_organization_id or v_existing.session_id <> p_session_id then
      raise exception 'QUOTA_REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object(
      'allowed', true,
      'mode', v_existing.enforcement_mode,
      'reservation_id', v_existing.id,
      'reason', v_existing.shadow_would_deny,
      'replayed', true
    );
  end if;

  if v_quota.organization_id is null then
    -- Sin fila de cuota: nunca acceso ilimitado. Una organización solo usa
    -- el chat sin límites si tiene una fila EXPLÍCITA en 'off'.
    return jsonb_build_object('allowed', false, 'mode', 'unconfigured', 'reservation_id', null, 'reason', 'quota_not_configured', 'replayed', false);
  end if;

  if v_quota.enforcement_mode = 'off' then
    return jsonb_build_object('allowed', true, 'mode', 'off', 'reservation_id', null, 'reason', null, 'replayed', false);
  end if;

  select * into v_price from public.model_prices where model = p_model;
  if not found then
    -- Sin precio no hay forma de acotar el costo: 'enforce' deniega,
    -- 'shadow' deja pasar sin registrar (nunca un costo inventado).
    return jsonb_build_object(
      'allowed', v_quota.enforcement_mode = 'shadow',
      'mode', v_quota.enforcement_mode,
      'reservation_id', null,
      'reason', 'model_price_missing',
      'replayed', false
    );
  end if;

  if v_quota.plan_code is not null then
    select * into v_plan from public.plans where code = v_quota.plan_code;
  end if;

  v_conversation_limit := coalesce(v_quota.conversation_limit_override, v_plan.monthly_conversation_limit);
  v_budget := coalesce(v_quota.budget_micros_override, v_plan.monthly_budget_micros);
  v_hourly_cap := coalesce(v_quota.hourly_message_cap_override, v_plan.hourly_message_cap);

  v_estimated := public.quota_cost_micros(
    p_estimated_input_tokens, p_max_output_tokens,
    v_price.input_micros_per_mtok, v_price.output_micros_per_mtok
  );

  select * into v_usage
  from public.usage_periods
  where organization_id = p_organization_id and period_start = v_period;

  v_is_new_conversation := not exists (
    select 1 from public.usage_conversations
    where organization_id = p_organization_id and session_id = p_session_id
  );

  select count(*) into v_recent_count
  from public.usage_reservations
  where organization_id = p_organization_id and created_at > now() - interval '1 hour';

  -- Decidir ANTES de escribir nada.
  if v_quota.status = 'suspended' then
    v_deny := 'suspended';
  elsif v_conversation_limit is null or v_budget is null then
    v_deny := 'limit_not_configured';
  elsif v_hourly_cap is not null and v_recent_count >= v_hourly_cap then
    v_deny := 'hourly_cap_reached';
  elsif v_is_new_conversation and coalesce(v_usage.conversations_used, 0) >= v_conversation_limit then
    v_deny := 'conversation_limit_reached';
  elsif coalesce(v_usage.settled_micros, 0) + coalesce(v_usage.reserved_micros, 0) + v_estimated > v_budget then
    v_deny := 'budget_exhausted';
  end if;

  if v_deny is not null and v_quota.enforcement_mode = 'enforce' then
    -- Retorno sin ninguna escritura previa: nada consumido ni contado.
    return jsonb_build_object('allowed', false, 'mode', 'enforce', 'reservation_id', null, 'reason', v_deny, 'replayed', false);
  end if;

  -- A partir de aquí: permitido ('enforce') o modo 'shadow'.
  insert into public.usage_reservations (
    request_id, organization_id, session_id, period_start, enforcement_mode, model,
    estimated_input_tokens, max_output_tokens,
    input_micros_per_mtok, output_micros_per_mtok,
    estimated_micros, shadow_would_deny
  ) values (
    p_request_id, p_organization_id, p_session_id, v_period, v_quota.enforcement_mode, p_model,
    p_estimated_input_tokens, p_max_output_tokens,
    v_price.input_micros_per_mtok, v_price.output_micros_per_mtok,
    v_estimated, case when v_quota.enforcement_mode = 'shadow' then v_deny end
  )
  returning id into v_reservation_id;

  if v_is_new_conversation then
    insert into public.usage_conversations (organization_id, session_id, period_start)
    values (p_organization_id, p_session_id, v_period);
  end if;

  insert into public.usage_periods (
    organization_id, period_start, conversations_used, messages_used, reserved_micros
  ) values (
    p_organization_id, v_period, case when v_is_new_conversation then 1 else 0 end, 1, v_estimated
  )
  on conflict (organization_id, period_start) do update set
    conversations_used = public.usage_periods.conversations_used + excluded.conversations_used,
    messages_used = public.usage_periods.messages_used + 1,
    reserved_micros = public.usage_periods.reserved_micros + excluded.reserved_micros,
    updated_at = now();

  return jsonb_build_object(
    'allowed', true,
    'mode', v_quota.enforcement_mode,
    'reservation_id', v_reservation_id,
    'reason', case when v_quota.enforcement_mode = 'shadow' then v_deny end,
    'replayed', false
  );
end;
$$;

-- ── 10. settle_chat_usage() ────────────────────────────────────────────────
-- p_input_tokens/p_output_tokens NULL (ambos) = uso real desconocido (fallo,
-- aborto) → se conserva la estimación. 0/0 = llamada sin costo. Idempotente:
-- una reserva ya liquidada devuelve su resultado original sin tocar nada.
-- Devuelve jsonb: {reservation_id, actual_micros, basis, replayed}.
create or replace function public.settle_chat_usage(
  p_reservation_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_model text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
-- Mismo motivo que reserve_chat_usage(). Si aborta, el backend reintenta
-- una vez y, si vuelve a fallar, la reserva queda abierta hasta que
-- expire_stale_chat_reservations() la cierre por su estimación.
set lock_timeout = '2s'
as $$
declare
  v_org uuid;
  v_reservation public.usage_reservations%rowtype;
  v_price public.model_prices%rowtype;
  v_model text := nullif(trim(coalesce(p_model, '')), '');
  v_actual bigint;
  v_basis text;
begin
  if p_reservation_id is null
     or (p_input_tokens is null) <> (p_output_tokens is null)
     or p_input_tokens < 0 or p_output_tokens < 0 then
    raise exception 'QUOTA_INVALID_ARGUMENT';
  end if;

  select organization_id into v_org from public.usage_reservations where id = p_reservation_id;
  if not found then
    raise exception 'QUOTA_RESERVATION_NOT_FOUND';
  end if;

  -- Mismo orden de bloqueo que reserve_chat_usage(): organización primero.
  perform 1 from public.organization_quotas where organization_id = v_org for update;

  select * into v_reservation from public.usage_reservations where id = p_reservation_id for update;

  if v_reservation.status = 'settled' then
    return jsonb_build_object(
      'reservation_id', v_reservation.id,
      'actual_micros', v_reservation.actual_micros,
      'basis', v_reservation.settlement_basis,
      'replayed', true
    );
  end if;

  if p_input_tokens is null then
    v_actual := v_reservation.estimated_micros;
    v_basis := 'estimated';
  elsif v_model is null or v_model = v_reservation.model then
    v_actual := public.quota_cost_micros(
      p_input_tokens, p_output_tokens,
      v_reservation.input_micros_per_mtok, v_reservation.output_micros_per_mtok
    );
    v_basis := 'actual';
  else
    select * into v_price from public.model_prices where model = v_model;
    if found then
      v_actual := public.quota_cost_micros(
        p_input_tokens, p_output_tokens,
        v_price.input_micros_per_mtok, v_price.output_micros_per_mtok
      );
      v_basis := 'actual';
    else
      v_actual := greatest(
        v_reservation.estimated_micros,
        public.quota_cost_micros(
          p_input_tokens, p_output_tokens,
          v_reservation.input_micros_per_mtok, v_reservation.output_micros_per_mtok
        )
      );
      v_basis := 'reservation_price';
    end if;
  end if;

  update public.usage_reservations set
    status = 'settled',
    actual_input_tokens = p_input_tokens,
    actual_output_tokens = p_output_tokens,
    actual_model = v_model,
    actual_micros = v_actual,
    settlement_basis = v_basis,
    settled_at = now()
  where id = v_reservation.id;

  -- Siempre al periodo de la RESERVA, aunque hoy sea otro mes.
  update public.usage_periods set
    reserved_micros = reserved_micros - v_reservation.estimated_micros,
    settled_micros = settled_micros + v_actual,
    updated_at = now()
  where organization_id = v_reservation.organization_id
    and period_start = v_reservation.period_start;

  if not found then
    raise exception 'QUOTA_PERIOD_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'reservation_id', v_reservation.id,
    'actual_micros', v_actual,
    'basis', v_basis,
    'replayed', false
  );
end;
$$;

-- ── 11. get_organization_quota_status(): solo lectura ──────────────────────
-- Para la comprobación previa al crear una sesión (Fase 4). No bloquea ni
-- escribe; la decisión autoritativa es siempre reserve_chat_usage().
--
-- p_model (opcional): si se pasa, la respuesta incluye
-- 'model_price_configured' (true/false) — si model_prices tiene una fila
-- para ESE identificador exacto. Permite no abrir en 'enforce' una
-- conversación cuyo primer mensaje reserve_chat_usage() denegaría con
-- 'model_price_missing'. Sin p_model, la respuesta es la de siempre.
--
-- La versión anterior tenía la firma (uuid). Una sobrecarga (uuid, text
-- default null) junto a ella haría AMBIGUA toda llamada con un solo
-- argumento ("function is not unique"), también vía PostgREST, así que la
-- anterior se elimina antes de crear esta.
drop function if exists public.get_organization_quota_status(uuid);

create or replace function public.get_organization_quota_status(
  p_organization_id uuid,
  p_model text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_period date := date_trunc('month', now() at time zone 'utc')::date;
  v_quota public.organization_quotas%rowtype;
  v_plan public.plans%rowtype;
  v_usage public.usage_periods%rowtype;
  v_price jsonb := '{}'::jsonb;
begin
  if p_organization_id is null then
    raise exception 'QUOTA_INVALID_ARGUMENT';
  end if;

  if p_model is not null then
    v_price := jsonb_build_object(
      'model_price_configured',
      exists (select 1 from public.model_prices where model = p_model)
    );
  end if;

  select * into v_quota from public.organization_quotas where organization_id = p_organization_id;
  if not found then
    return jsonb_build_object('mode', 'unconfigured', 'period_start', v_period) || v_price;
  end if;

  if v_quota.plan_code is not null then
    select * into v_plan from public.plans where code = v_quota.plan_code;
  end if;

  select * into v_usage
  from public.usage_periods
  where organization_id = p_organization_id and period_start = v_period;

  return jsonb_build_object(
    'mode', v_quota.enforcement_mode,
    'status', v_quota.status,
    'plan_code', v_quota.plan_code,
    'period_start', v_period,
    'conversation_limit', coalesce(v_quota.conversation_limit_override, v_plan.monthly_conversation_limit),
    'budget_micros', coalesce(v_quota.budget_micros_override, v_plan.monthly_budget_micros),
    'hourly_message_cap', coalesce(v_quota.hourly_message_cap_override, v_plan.hourly_message_cap),
    'conversations_used', coalesce(v_usage.conversations_used, 0),
    'messages_used', coalesce(v_usage.messages_used, 0),
    'reserved_micros', coalesce(v_usage.reserved_micros, 0),
    'settled_micros', coalesce(v_usage.settled_micros, 0)
  ) || v_price;
end;
$$;

-- ── 12. Privilegios de ejecución: solo service_role ───────────────────────
-- Postgres otorga EXECUTE a PUBLIC al crear una función, y Supabase además
-- lo otorga explícitamente a anon/authenticated por default privileges —
-- por eso se revoca de los tres, igual que claim_webhook_deliveries().
revoke all on function public.quota_cost_micros(bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.reserve_chat_usage(uuid, uuid, uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.settle_chat_usage(uuid, integer, integer, text) from public, anon, authenticated;
revoke all on function public.get_organization_quota_status(uuid, text) from public, anon, authenticated;

grant execute on function public.quota_cost_micros(bigint, bigint, bigint, bigint) to service_role;
grant execute on function public.reserve_chat_usage(uuid, uuid, uuid, text, integer, integer) to service_role;
grant execute on function public.settle_chat_usage(uuid, integer, integer, text) to service_role;
grant execute on function public.get_organization_quota_status(uuid, text) to service_role;

-- ── 13. Cuota automática para organizaciones nuevas ───────────────────────
-- Toda organización insertada después de esta migración recibe su fila en
-- organization_quotas en modo 'shadow' (plan 'pilot'), para que ninguna
-- quede sin fila (= 'unconfigured', que reserve_chat_usage() deniega).
--
-- SECURITY DEFINER es necesario: quien inserta en organizations suele ser
-- el propio usuario (rol authenticated, alta automática de
-- OrganizationProvider.tsx), que no tiene ningún privilegio sobre
-- organization_quotas (sección 7). La función corre como su dueño (el rol
-- que ejecuta este script), que sí lo tiene. Es segura porque el usuario no
-- controla nada de lo que escribe: solo NEW.id (la organización que acaba
-- de crear); plan y modo están fijados aquí, y ON CONFLICT DO NOTHING
-- impide sobrescribir una fila existente (p. ej. una en 'enforce' u 'off').
-- El plan se busca en vez de escribirse literal: si 'pilot' no existiera,
-- queda NULL en lugar de romper la FK.
--
-- BEGIN...EXCEPTION WHEN OTHERS, igual que notify_lead_created(): un fallo
-- aquí no debe impedir crear la organización (eso rompería el registro de
-- usuarios). Es seguro tragarlo porque una organización sin fila queda
-- DENEGADA, no ilimitada; RAISE WARNING lo deja en el log de Postgres.
create or replace function public.create_default_organization_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into public.organization_quotas (organization_id, plan_code, enforcement_mode)
    values (NEW.id, (select code from public.plans where code = 'pilot'), 'shadow')
    on conflict (organization_id) do nothing;
  exception
    when others then
      raise warning 'create_default_organization_quota: no se pudo crear la cuota de la organización %: % (SQLSTATE %)',
        NEW.id, SQLERRM, SQLSTATE;
  end;
  return NEW;
end;
$$;

-- Higiene (como notify_lead_created): disparar un trigger no requiere
-- EXECUTE, y Postgres no permite llamar directamente a una función
-- `returns trigger`.
revoke all on function public.create_default_organization_quota() from public, anon, authenticated;

drop trigger if exists organizations_create_default_quota on public.organizations;
create trigger organizations_create_default_quota
  after insert on public.organizations
  for each row
  execute function public.create_default_organization_quota();

-- ── 14. expire_stale_chat_reservations(): reservas abandonadas ─────────────
-- Cierra las reservas que siguen en 'reserved' más de p_older_than (mínimo y
-- valor por defecto: 15 minutos) — el proceso murió entre la reserva y la
-- liquidación (reinicio/SIGKILL de Railway) o la liquidación falló dos
-- veces. Resumen operativo en CLAUDE.md ("Monthly chat quotas").
--
-- * NUNCA gratis: se cierran por su estimated_micros COMPLETO (cota
--   superior), con settlement_basis = 'expired'. Una llamada que pudo
--   facturarse nunca se libera. Mover reserved → settled por el mismo
--   importe no cambia el presupuesto disponible.
-- * ABANDONADA vs ACTIVA: solo el reloj de Postgres (created_at y now()).
--   Una reserva activa vive como mucho ~70 s con los timeouts actuales del
--   backend (REQUEST_TIMEOUT_MS = 45 s en routes/chat.ts + timeouts de las
--   RPC y de usage_events); 15 min deja un margen de más de 10×. El mínimo
--   de 15 min está forzado aquí: ningún llamador puede pedir menos.
-- * ATÓMICA por organización: subtransacción (BEGIN…EXCEPTION) bajo el
--   bloqueo de su fila de organization_quotas — las reservas y los
--   contadores de sus periodos cambian juntos o no cambian. Un fallo en una
--   organización revierte solo esa organización y se reporta.
-- * CONCURRENCIA: mismo orden de bloqueo que reserve/settle (organización
--   primero) y SKIP LOCKED: una organización atendiendo un mensaje ahora
--   mismo se salta y se procesa en la pasada siguiente; esta función nunca
--   hace esperar al tráfico real. Organizaciones en orden fijo: sin
--   deadlocks entre varias ejecuciones simultáneas.
-- * IDEMPOTENTE: el UPDATE vuelve a exigir status = 'reserved' tras obtener
--   el bloqueo de fila, así que una liquidación que gane la carrera no se
--   cuenta dos veces, y una segunda ejecución no cambia nada. Una
--   liquidación que llegue DESPUÉS recibe la reserva ya cerrada (replay).
-- * CAMBIO DE MES: cada reserva se aplica a SU period_start, igual que
--   settle_chat_usage().
-- * ACOTADA: p_max_organizations por llamada; el resto, en la siguiente.
--
-- Devuelve jsonb: {expired_count, expired_micros, organizations_processed,
-- organizations_skipped_locked, organizations_failed}.
create or replace function public.expire_stale_chat_reservations(
  p_older_than interval default interval '15 minutes',
  p_max_organizations integer default 100
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set lock_timeout = '2s'
as $$
declare
  v_org uuid;
  v_count integer;
  v_micros bigint;
  v_missing_periods integer;
  v_expired_count integer := 0;
  v_expired_micros bigint := 0;
  v_processed integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
begin
  if p_older_than is null or p_older_than < interval '15 minutes'
     or p_max_organizations is null or p_max_organizations < 1 or p_max_organizations > 1000 then
    raise exception 'QUOTA_INVALID_ARGUMENT';
  end if;

  for v_org in
    select r.organization_id
    from public.usage_reservations r
    where r.status = 'reserved' and r.created_at < now() - p_older_than
    group by r.organization_id
    order by r.organization_id
    limit p_max_organizations
  loop
    begin
      -- Organización primero. Sin fila de cuota (borrada a mano) no hay
      -- nada que bloquear: settle_chat_usage() tampoco bloquea en ese caso.
      if exists (select 1 from public.organization_quotas where organization_id = v_org) then
        perform 1 from public.organization_quotas
        where organization_id = v_org
        for update skip locked;
        if not found then
          v_skipped := v_skipped + 1;
          continue;
        end if;
      end if;

      with expired as (
        update public.usage_reservations r set
          status = 'settled',
          actual_micros = r.estimated_micros,
          settlement_basis = 'expired',
          settled_at = now()
        where r.organization_id = v_org
          and r.status = 'reserved'
          and r.created_at < now() - p_older_than
        returning r.period_start, r.estimated_micros
      ), per_period as (
        select period_start, sum(estimated_micros)::bigint as micros, count(*)::integer as n
        from expired
        group by period_start
      ), updated as (
        update public.usage_periods p set
          reserved_micros = p.reserved_micros - pp.micros,
          settled_micros = p.settled_micros + pp.micros,
          updated_at = now()
        from per_period pp
        where p.organization_id = v_org and p.period_start = pp.period_start
        returning p.period_start
      )
      select
        (select coalesce(sum(n), 0) from per_period),
        (select coalesce(sum(micros), 0) from per_period),
        (select count(*) from per_period) - (select count(*) from updated)
      into v_count, v_micros, v_missing_periods;

      -- Un periodo inexistente rompería el invariante reserved_micros =
      -- suma de reservas abiertas: se revierte esta organización entera.
      -- (Un reserved_micros negativo lo impide ya su CHECK >= 0.)
      if v_missing_periods > 0 then
        raise exception 'QUOTA_PERIOD_NOT_FOUND';
      end if;

      v_expired_count := v_expired_count + v_count;
      v_expired_micros := v_expired_micros + v_micros;
      v_processed := v_processed + 1;
    exception
      when others then
        v_failed := v_failed + 1;
        raise warning 'expire_stale_chat_reservations: organización % no conciliada: % (SQLSTATE %)',
          v_org, SQLERRM, SQLSTATE;
    end;
  end loop;

  return jsonb_build_object(
    'expired_count', v_expired_count,
    'expired_micros', v_expired_micros,
    'organizations_processed', v_processed,
    'organizations_skipped_locked', v_skipped,
    'organizations_failed', v_failed
  );
end;
$$;

revoke all on function public.expire_stale_chat_reservations(interval, integer) from public, anon, authenticated;
grant execute on function public.expire_stale_chat_reservations(interval, integer) to service_role;
