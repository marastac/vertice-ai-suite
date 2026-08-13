-- Lead AI — chat sessions/messages migration (existing project)
--
-- Run this once in the Supabase project's SQL editor. Adds TWO new tables
-- (chat_sessions, chat_messages) and FOUR new SECURITY DEFINER functions.
-- No existing table, column, or RLS policy is modified — purely additive.
-- Safe to re-run (create/policy statements below use if-not-exists/drop-then-
-- recreate; function statements use create or replace).
--
-- Why: /conversations used to read only the current browser's localStorage
-- mirror of a chat conversation — an anonymous visitor's chat (e.g. from an
-- incognito window) was invisible to every other browser, including the
-- authenticated dashboard. This migration gives chat conversations a real,
-- organization-scoped home in Postgres so /conversations becomes a genuine
-- cross-device listing.
--
-- Security model, reviewed and approved before implementation: chat_sessions
-- and chat_messages have RLS enabled with ONLY select/delete policies
-- (member-only, via is_org_member — no public/anon policy at all, since a
-- transcript is PII). There is NO insert/update policy for any role on
-- either table. Every write (from the anonymous public chat page) goes
-- through one of the four SECURITY DEFINER functions below, each with its
-- own explicit server-side validation — see each function's comment for
-- exactly what it checks and why.

-- ── tables ────────────────────────────────────────────────────────────────
create table if not exists chat_sessions (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  org_slug text not null,
  assistant_name text not null,
  qualification jsonb,
  lead_id uuid references leads(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table chat_sessions enable row level security;
drop policy if exists "chat_sessions_select" on chat_sessions;
drop policy if exists "chat_sessions_delete" on chat_sessions;
create policy "chat_sessions_select" on chat_sessions for select using (is_org_member(organization_id));
create policy "chat_sessions_delete" on chat_sessions for delete using (is_org_member(organization_id));

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
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

-- ── verification ──────────────────────────────────────────────────────────
select proname from pg_proc
where proname in ('create_public_chat_session', 'append_chat_message', 'set_chat_session_qualification', 'link_chat_session_lead')
order by proname;
-- Expect 4 rows.
