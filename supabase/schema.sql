-- Lead AI — Phase 6 schema
--
-- Run this once in the Supabase project's SQL editor (Project → SQL Editor →
-- New query → paste → Run). Idempotent-ish: uses IF NOT EXISTS where sensible,
-- but is meant to be run once against a fresh project.
--
-- ⚠️ SECURITY TRADE-OFF, READ BEFORE APPLYING ⚠️
-- Row Level Security is enabled on every table below, but the policies are
-- permissive ("using (true)") because there is no authentication in this
-- phase — there is no user context to scope access by yet. This means the
-- anon key shipped in the frontend bundle can read and write every row in
-- every one of these tables directly via Supabase's REST API, not just
-- through the app's UI. This is a deliberate, time-boxed decision for a
-- single-tenant internal tool kept off a public/discoverable URL — it is
-- expected to be closed by the auth phase, not a permanent stance. See
-- CLAUDE.md "Phase 6: Supabase persistence" for the full explanation.

-- created_by columns below are deliberately a plain `uuid`, NOT
-- `references auth.users(id)`. Referencing the auth schema from a SQL-editor
-- paste is a known Supabase friction point (the exact role/grants context
-- the editor runs under can reject it with a permission error) — and
-- because the editor sends a whole pasted script as one implicit
-- transaction, a single failing statement anywhere rolls back the entire
-- script, including tables earlier in the file. Nothing writes to
-- created_by yet (it's always NULL until the auth phase), so the FK isn't
-- load-bearing today; add it later via a plain
-- `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (created_by) REFERENCES auth.users(id)`
-- once auth exists and that context is confirmed to have the right grants.

-- ── team_members ────────────────────────────────────────────────────────
-- Currently a hardcoded 3-row array in the frontend. Migrated here so
-- leads.assigned_to can be a real foreign key. Not wired to any auth.
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  role text not null check (role in ('owner', 'admin', 'member'))
);

alter table team_members enable row level security;
drop policy if exists "team_members_select" on team_members;
drop policy if exists "team_members_insert" on team_members;
drop policy if exists "team_members_update" on team_members;
drop policy if exists "team_members_delete" on team_members;
create policy "team_members_select" on team_members for select using (true);
create policy "team_members_insert" on team_members for insert with check (true);
create policy "team_members_update" on team_members for update using (true);
create policy "team_members_delete" on team_members for delete using (true);

-- ── forms ────────────────────────────────────────────────────────────────
create table if not exists forms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null check (status in ('draft', 'active')),
  questions jsonb not null default '[]',
  created_by uuid, -- always NULL until the auth phase — see note above
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table forms enable row level security;
drop policy if exists "forms_select" on forms;
drop policy if exists "forms_insert" on forms;
drop policy if exists "forms_update" on forms;
drop policy if exists "forms_delete" on forms;
create policy "forms_select" on forms for select using (true);
create policy "forms_insert" on forms for insert with check (true);
create policy "forms_update" on forms for update using (true);
create policy "forms_delete" on forms for delete using (true);

-- ── leads ────────────────────────────────────────────────────────────────
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
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
  created_by uuid, -- always NULL until the auth phase — see note near the top of this file
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
create unique index if not exists leads_chat_session_id_key
  on leads (chat_session_id);

alter table leads enable row level security;
drop policy if exists "leads_select" on leads;
drop policy if exists "leads_insert" on leads;
drop policy if exists "leads_update" on leads;
drop policy if exists "leads_delete" on leads;
create policy "leads_select" on leads for select using (true);
create policy "leads_insert" on leads for insert with check (true);
create policy "leads_update" on leads for update using (true);
create policy "leads_delete" on leads for delete using (true);

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
create policy "form_submissions_select" on form_submissions for select using (true);
create policy "form_submissions_insert" on form_submissions for insert with check (true);
create policy "form_submissions_update" on form_submissions for update using (true);
create policy "form_submissions_delete" on form_submissions for delete using (true);

-- ── lead_activity ────────────────────────────────────────────────────────
-- The one place normalization is chosen over jsonb: this array is unbounded
-- and append-only for the life of a lead. jsonb has no efficient append —
-- every update() would otherwise rewrite the entire history. A real table
-- lets new entries be genuine INSERTs.
create table if not exists lead_activity (
  id uuid primary key default gen_random_uuid(),
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
create policy "lead_activity_select" on lead_activity for select using (true);
create policy "lead_activity_insert" on lead_activity for insert with check (true);
create policy "lead_activity_update" on lead_activity for update using (true);
create policy "lead_activity_delete" on lead_activity for delete using (true);

-- ── chat_configuration ───────────────────────────────────────────────────
-- Singleton-per-org config. org_slug already exists conceptually elsewhere
-- (ChatSession.orgSlug, the /c/:orgSlug route) — adding it here now costs
-- nothing and avoids a schema rewrite when multi-org support is eventually
-- unblocked (still explicitly deferred; only one row will ever exist here:
-- 'vertice-agency').
create table if not exists chat_configuration (
  id uuid primary key default gen_random_uuid(),
  org_slug text not null unique default 'vertice-agency',
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
  created_by uuid, -- always NULL until the auth phase — see note near the top of this file
  updated_at timestamptz not null default now()
);

alter table chat_configuration enable row level security;
drop policy if exists "chat_configuration_select" on chat_configuration;
drop policy if exists "chat_configuration_insert" on chat_configuration;
drop policy if exists "chat_configuration_update" on chat_configuration;
drop policy if exists "chat_configuration_delete" on chat_configuration;
create policy "chat_configuration_select" on chat_configuration for select using (true);
create policy "chat_configuration_insert" on chat_configuration for insert with check (true);
create policy "chat_configuration_update" on chat_configuration for update using (true);
create policy "chat_configuration_delete" on chat_configuration for delete using (true);

-- ── Chat sessions/messages — DESIGN ONLY, NOT CREATED ───────────────────
-- Phase 5 already hardened server/data/sessions.json end-to-end (verified
-- restart-survival). There is no requirement to move it this phase, and
-- doing so now would add risk with no immediate benefit. Left here only so
-- the shape is on record if a later phase decides to migrate:
--
-- create table chat_sessions (
--   id uuid primary key default gen_random_uuid(),
--   org_slug text not null,
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
