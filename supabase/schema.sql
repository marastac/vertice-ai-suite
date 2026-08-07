-- Lead AI — schema (Phase 6 persistence + Phase 8 multi-tenancy)
--
-- Run this once in the Supabase project's SQL editor (Project → SQL Editor →
-- New query → paste → Run). Meant for a FRESH project. If your project
-- already has Phase 6/7 data in it, do NOT run this file — run
-- supabase/migrations-phase8.sql instead, which backfills organization_id
-- onto existing rows non-destructively. This file assumes empty tables.
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
-- NOT covered by this policy — see organization_invites below, which is
-- table+RLS only this phase; the accept-invite flow is future work.
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

-- ── Chat sessions/messages — DESIGN ONLY, NOT CREATED ───────────────────
-- Phase 5 already hardened server/data/sessions.json end-to-end (verified
-- restart-survival). There is no requirement to move it this phase, and
-- doing so now would add risk with no immediate benefit. Chat sessions
-- already carry an orgSlug field client-side (entities/chat/types.ts's
-- ChatSession) — that's enough for Phase 8's purposes since this data is
-- browser-local storage, not a shared database; "isolation" doesn't apply
-- to data that's already structurally unreachable by anyone else. Left here
-- only so the shape is on record if a later phase decides to migrate:
--
-- create table chat_sessions (
--   id uuid primary key default gen_random_uuid(),
--   organization_id uuid not null references organizations(id) on delete cascade,
--   config jsonb not null,
--   qualification jsonb,
--   created_at timestamptz not null default now(),
--   updated_at timestamptz not null default now()
-- );
-- create table chat_messages (
--   id uuid primary key default gen_random_uuid(),
--   session_id uuid not null references chat_sessions(id) on delete cascade,
--   role text not null check (role in ('user', 'assistant')),
--   content text not null,
--   created_at timestamptz not null default now()
-- );
