-- Lead AI — Fase 10: member role management (change role, remove member)
--
-- Run this once in the Supabase project's SQL editor, on a project that
-- already ran migrations-team-invites-team-members.sql (organization_members,
-- team_members, accept_invite() with its team_members insert, and the
-- widened team_members.role check constraint must already exist).
--
-- This script is purely additive/replacing — it does not touch any existing
-- row of data, and does not change accept_invite()'s behavior at all. Safe
-- to re-run (every statement is idempotent: drop-if-exists + create,
-- create-or-replace, or drop-constraint-if-exists + add-constraint).
--
-- What this does, in order:
--   1. Tightens organization_members' UPDATE/DELETE RLS policies so an admin
--      can no longer modify/delete the owner's row, modify/delete their own
--      row, or grant 'owner' to anyone — closing a privilege-escalation gap
--      that existed before this migration (the old policies only checked
--      "is the caller an admin of this organization", never which row was
--      being touched or what the new role would be).
--   2. Tightens team_members' INSERT/UPDATE/DELETE RLS from is_org_member to
--      is_org_admin — now that this table mirrors real membership, a
--      non-admin (even a viewer) should not be able to freely edit or delete
--      rows in it via a direct REST call. SELECT stays is_org_member — the
--      whole team can still see the roster.
--   3. Creates a trigger that mirrors every organization_members role change
--      or removal into team_members automatically, so the two tables can
--      never drift apart again regardless of which code path changes
--      organization_members (these new RPCs, a future RPC, or a manual SQL
--      statement run directly in this editor).
--   4. Creates update_member_role(organization_id, team_member_id, new_role)
--      and remove_organization_member(organization_id, team_member_id) —
--      the only sanctioned application entry points for these two actions.
--      Both are SECURITY DEFINER (so they bypass RLS) and therefore
--      re-validate every rule themselves, in the same explicit, ordered
--      style as accept_invite(): authenticate, authorize (caller must be
--      owner or admin of that organization), validate the new role,
--      resolve the target member, refuse to touch the owner, refuse to
--      let anyone touch their own row, only then mutate.
--
-- Nothing here requires re-running schema.sql, migrations-phase8.sql,
-- migrations-team-invites.sql, or migrations-team-invites-team-members.sql —
-- this migration only ADDS the two new RLS restrictions, the trigger, and
-- the two new functions on top of what those already put in place.

-- ── 1. tighten organization_members UPDATE/DELETE ────────────────────────
drop policy if exists "organization_members_update_admins" on organization_members;
drop policy if exists "organization_members_delete_admins" on organization_members;
create policy "organization_members_update_admins" on organization_members for update
  using (is_org_admin(organization_id) and user_id <> auth.uid() and role <> 'owner')
  with check (role <> 'owner');
create policy "organization_members_delete_admins" on organization_members for delete
  using (is_org_admin(organization_id) and user_id <> auth.uid() and role <> 'owner');

-- ── 2. tighten team_members INSERT/UPDATE/DELETE ─────────────────────────
drop policy if exists "team_members_insert" on team_members;
drop policy if exists "team_members_update" on team_members;
drop policy if exists "team_members_delete" on team_members;
create policy "team_members_insert" on team_members for insert with check (is_org_admin(organization_id));
create policy "team_members_update" on team_members for update using (is_org_admin(organization_id));
create policy "team_members_delete" on team_members for delete using (is_org_admin(organization_id));

-- ── 3. sync trigger: organization_members → team_members ─────────────────
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

-- ── 4. update_member_role, remove_organization_member ────────────────────
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

  delete from organization_members
  where organization_id = p_organization_id and user_id = v_target_user_id;
end;
$$;

revoke execute on function remove_organization_member(uuid, uuid) from public;
grant execute on function remove_organization_member(uuid, uuid) to authenticated;

-- ── verification ──────────────────────────────────────────────────────────
-- 1) Confirm both functions exist and are granted only to 'authenticated'
--    (no 'anon' entry — unlike get_invite_by_token, these must never be
--    callable by a logged-out visitor).
select proname, proacl from pg_proc
where proname in ('update_member_role', 'remove_organization_member', 'sync_team_member_on_organization_member_change');

-- 2) Confirm the trigger is attached.
select tgname, tgrelid::regclass, tgenabled from pg_trigger where tgname = 'organization_members_sync_team_members';

-- 3) Manual smoke test (run as yourself, an owner, in the SQL editor — this
--    bypasses auth.uid()-based checks since the SQL editor runs as a
--    superuser-like role, so it only proves the trigger fires, not the RPC's
--    own validation; test the RPCs themselves from the app or via
--    supabase.rpc(...) in the browser console while signed in):
--      update organization_members set role = 'admin'
--        where organization_id = '<some org id>' and user_id = '<some non-owner member's user id>';
--      -- then check team_members picked up the same role change:
--      select * from team_members where organization_id = '<same org id>';
