-- Lead AI — team invite RPCs (new feature, existing project)
--
-- Run this once in the Supabase project's SQL editor, on a project that
-- already ran schema.sql (or migrations-phase8.sql), so organizations,
-- organization_members, and organization_invites already exist. Adds TWO
-- new functions and grants execute permission on them — no existing table,
-- column, or RLS policy is modified. Safe to re-run (create or replace +
-- revoke/grant are all idempotent).
--
-- Why this is needed: organization_invites/organization_members RLS is
-- member/admin-only by design (see schema.sql's comments on those
-- policies) — a not-yet-a-member invitee can't pass either policy, on
-- purpose, since an invite token is effectively a bearer credential. These
-- two SECURITY DEFINER functions are the only path in: one to preview an
-- invite by its token before the visitor is a member of anything, one to
-- actually accept it.

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
  -- organizations_select_public in schema.sql) and the offered role —
  -- never the invite's email or who sent it. Safe to expose to anon: a
  -- logged-out visitor must be able to preview an invite before signing
  -- in/up. is_usable is computed here, not left for the frontend to derive
  -- from expires_at, so a client clock never factors into the decision;
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
-- avoids the auth-schema grants friction documented in schema.sql) matches
-- organization_invites.email, case-insensitively. Only after all three
-- pass does it even look at organization_members — the insert is safe to
-- run unconditionally (ON CONFLICT DO NOTHING covers an already-a-member
-- caller, e.g. a double-click or a redundant invite), and the invite is
-- always marked 'accepted' afterward so it never lingers 'pending' once
-- its conditions are genuinely satisfied — including for a caller who
-- turns out to already be a member.
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
  on conflict (organization_id, user_id) do nothing;

  update organization_invites set status = 'accepted' where id = v_invite.id;

  return query select v_org.id, v_org.slug;
end;
$$;

revoke execute on function accept_invite(uuid) from public;
grant execute on function accept_invite(uuid) to authenticated;

-- ── verification ──────────────────────────────────────────────────────────
select proname, proacl from pg_proc where proname in ('get_invite_by_token', 'accept_invite');
-- Expect two rows. get_invite_by_token's proacl should list execute grants
-- for anon and authenticated; accept_invite's should list authenticated
-- only (no anon entry).
