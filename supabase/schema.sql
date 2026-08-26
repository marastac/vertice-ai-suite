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
-- see CLAUDE.md's "Phase 9: Onboarding & copy" section. No RLS policy
-- changes were needed for this: the existing `organizations_update_members`
-- policy (`is_org_member`) already lets a member set these two columns on
-- their own organization.
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

grant execute on function is_org_member(uuid) to authenticated;
grant execute on function is_org_admin(uuid) to authenticated;

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
create policy "organizations_update_members" on organizations for update
  using (is_org_member(id));

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
create policy "organization_members_update_admins" on organization_members for update
  using (is_org_admin(organization_id));
create policy "organization_members_delete_admins" on organization_members for delete
  using (is_org_admin(organization_id));

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
-- already-a-member caller, e.g. a double-click or a redundant invite), and
-- the invite is always marked 'accepted' afterward so it never lingers
-- 'pending' once its conditions are genuinely satisfied — including for a
-- caller who turns out to already be a member.
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
  on conflict on constraint organization_members_organization_id_user_id_key do nothing;

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
  role text not null check (role in ('owner', 'admin', 'member'))
);
-- Email no longer globally unique (Phase 6) — two different organizations
-- may each have their own assignable "Alex Morgan"-shaped row. Unique per org instead.
create unique index if not exists team_members_org_email_key on team_members (organization_id, email);

alter table team_members enable row level security;
drop policy if exists "team_members_select" on team_members;
drop policy if exists "team_members_insert" on team_members;
drop policy if exists "team_members_update" on team_members;
drop policy if exists "team_members_delete" on team_members;
create policy "team_members_select" on team_members for select using (is_org_member(organization_id));
create policy "team_members_insert" on team_members for insert with check (is_org_member(organization_id));
create policy "team_members_update" on team_members for update using (is_org_member(organization_id));
create policy "team_members_delete" on team_members for delete using (is_org_member(organization_id));

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
create policy "forms_insert" on forms for insert with check (is_org_member(organization_id));
create policy "forms_update" on forms for update using (is_org_member(organization_id));
create policy "forms_delete" on forms for delete using (is_org_member(organization_id));

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
-- Public INSERT is intentional, not an oversight: a lead filling out
-- /f/:formId, or a website visitor qualifying through /c/:orgSlug, is never
-- signed in — both flows must be able to create a lead row. The
-- organization_id they write into comes from the form/chat config they're
-- already looking at (see entities/form/submission-service.ts and
-- entities/chat/qualification-service.ts), not from anything the visitor
-- chooses freely. Residual risk: a malicious anonymous client could still
-- POST a fabricated lead into a guessed organization_id (spam), same class
-- of risk as any public contact form — but never a READ of another
-- organization's data, since SELECT above stays member-only.
create policy "leads_insert" on leads for insert with check (true);
-- UPDATE is more restrictive than INSERT: an authenticated org member can
-- update any lead in their org (normal dashboard editing), but an anonymous
-- caller may only update a lead that already has a chat_session_id — i.e.
-- exactly the upsertByChatSession() path used mid-conversation on the public
-- chat page to refine an existing lead's score as qualification improves.
-- An anonymous caller can never update a lead created via the manual "Nuevo
-- lead" form or a form submission (those have no chat_session_id).
create policy "leads_update" on leads for update
  using (is_org_member(organization_id) or chat_session_id is not null)
  with check (is_org_member(organization_id) or chat_session_id is not null);
create policy "leads_delete" on leads for delete using (is_org_member(organization_id));

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
create policy "form_submissions_select" on form_submissions for select using (is_org_member(organization_id));
-- Public INSERT, same reasoning as leads above: a visitor submitting a
-- public form is never signed in.
create policy "form_submissions_insert" on form_submissions for insert with check (true);
create policy "form_submissions_update" on form_submissions for update using (is_org_member(organization_id));
create policy "form_submissions_delete" on form_submissions for delete using (is_org_member(organization_id));

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
-- Public INSERT: the first activity entry is written in the same anonymous
-- request that creates the lead (public form/chat flows).
create policy "lead_activity_insert" on lead_activity for insert with check (true);
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
-- multi-tenancy note at the top of this file.
create policy "chat_configuration_select" on chat_configuration for select using (true);
create policy "chat_configuration_insert" on chat_configuration for insert with check (is_org_member(organization_id));
create policy "chat_configuration_update" on chat_configuration for update using (is_org_member(organization_id));
create policy "chat_configuration_delete" on chat_configuration for delete using (is_org_member(organization_id));

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
