-- Lead AI — fix: accepted invites never created a team_members row
--
-- Run this once in the Supabase project's SQL editor, on a project that
-- already ran migrations-team-invites.sql (get_invite_by_token/accept_invite
-- already exist). Root cause: accept_invite() only ever inserted into
-- organization_members — a real, RLS-verified membership — but /team's
-- member list and the "Persona asignada" lead-assignment dropdown both read
-- team_members, a separate table that predates real auth-backed invites (see
-- CLAUDE.md's Phase 8 section for why the two were never merged). Result: an
-- invite could show "Aceptada" while the invitee never appeared anywhere in
-- the UI except (invisibly) as a Postgres row nobody displayed.
--
-- This script has three parts, all idempotent/safe to re-run:
--   1. Widen team_members.role's check constraint to allow 'viewer' — an
--      invite can grant that role (organization_invites.role mirrors
--      OrganizationRole), but team_members' constraint only ever allowed
--      'owner'/'admin'/'member'.
--   2. Replace accept_invite() so every *future* acceptance also inserts a
--      team_members row atomically with the organization_members insert.
--   3. Backfill: insert a team_members row for every organization_members
--      row that doesn't have one yet — this is what fixes an invite you
--      already accepted before this migration existed; the function change
--      in part 2 alone only affects acceptances from this point forward.

-- ── 1. widen the constraint ─────────────────────────────────────────────
alter table team_members drop constraint if exists team_members_role_check;
alter table team_members add constraint team_members_role_check check (role in ('owner', 'admin', 'member', 'viewer'));

-- ── 2. accept_invite(), now also inserting into team_members ────────────
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
  for update;

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

-- ── 3. backfill every existing member missing a team_members row ────────
-- Reads auth.users directly (fine for a one-off script run as the SQL
-- editor's elevated role — unlike a FK into auth.users, a plain SELECT
-- isn't the grants friction point documented elsewhere in this repo).
insert into team_members (organization_id, name, email, role)
select
  om.organization_id,
  coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)),
  u.email,
  om.role
from organization_members om
join auth.users u on u.id = om.user_id
on conflict (organization_id, email) do nothing;

-- ── verification ──────────────────────────────────────────────────────────
-- Expect one row per organization_members row (or more, if team_members
-- already had unrelated rows) — every real member should now be listed.
select o.name as organization, tm.name, tm.email, tm.role
from team_members tm
join organizations o on o.id = tm.organization_id
order by o.name, tm.name;
