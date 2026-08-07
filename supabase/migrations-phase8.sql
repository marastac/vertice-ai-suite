-- Lead AI — Phase 8 upgrade script for an EXISTING project
--
-- Use this instead of schema.sql if your Supabase project already has
-- Phase 6/7 data in it (leads, forms, chat_configuration rows created
-- before organization_id existed). Non-destructive: it backfills every
-- existing row into one default "Vertice Agency" organization rather than
-- deleting anything. Safe to re-run (every step is idempotent).
--
-- After running this file, you (the project owner) still need to run ONE
-- more statement by hand to become a member of that default organization —
-- see the very bottom of this file. Nothing in this script can know your
-- auth.users id on its own.
--
-- If you're setting up a brand-new project instead, run schema.sql (which
-- already includes everything below, built into the fresh table
-- definitions) — do not run both.

-- ── 1. New tables: organizations, organization_members, organization_invites,
--       plus the is_org_member/is_org_admin RLS helper functions ──────────
-- (identical to schema.sql's copy of this section — see there for the
-- recursion-avoidance rationale on security definer + search_path)
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

create or replace function is_org_member(target_org_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from organization_members
    where organization_id = target_org_id and user_id = auth.uid()
  );
$$;

create or replace function is_org_admin(target_org_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from organization_members
    where organization_id = target_org_id and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

grant execute on function is_org_member(uuid) to authenticated;
grant execute on function is_org_admin(uuid) to authenticated;

-- ── 2. The default organization every pre-Phase-8 row backfills into ────
insert into organizations (name, slug)
values ('Vertice Agency', 'vertice-agency')
on conflict (slug) do nothing;

-- ── 3. Add organization_id (nullable for now) to every existing table ───
alter table team_members add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table forms add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table leads add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table form_submissions add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table lead_activity add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table chat_configuration add column if not exists organization_id uuid references organizations(id) on delete cascade;

-- ── 4. Backfill existing rows ─────────────────────────────────────────────
-- team_members / forms / leads: no parent row to derive an org from, so
-- they all backfill straight into the default organization.
update team_members set organization_id = (select id from organizations where slug = 'vertice-agency') where organization_id is null;
update forms set organization_id = (select id from organizations where slug = 'vertice-agency') where organization_id is null;
update leads set organization_id = (select id from organizations where slug = 'vertice-agency') where organization_id is null;

-- form_submissions / lead_activity: derive from their parent row instead of
-- blindly assuming the default org — correct even if this script is ever
-- re-run after some forms/leads already belong to a different organization.
update form_submissions fs set organization_id = f.organization_id
  from forms f where fs.form_id = f.id and fs.organization_id is null;
update lead_activity la set organization_id = l.organization_id
  from leads l where la.lead_id = l.id and la.organization_id is null;

-- chat_configuration: match by slug (the pre-Phase-8 org_slug column is
-- literally the same string as the default organization's slug), then drop
-- the now-redundant column — organization_id is the single source of truth
-- going forward, resolved via organizations.slug for the public chat page.
update chat_configuration cc set organization_id = o.id
  from organizations o where cc.org_slug = o.slug and cc.organization_id is null;
alter table chat_configuration drop column if exists org_slug;

-- ── 5. Now that every row has an organization_id, enforce it ────────────
alter table team_members alter column organization_id set not null;
alter table forms alter column organization_id set not null;
alter table leads alter column organization_id set not null;
alter table form_submissions alter column organization_id set not null;
alter table lead_activity alter column organization_id set not null;
alter table chat_configuration alter column organization_id set not null;

-- team_members.email was globally unique pre-Phase-8; now unique per
-- organization instead (two orgs may each have their own "Alex Morgan").
alter table team_members drop constraint if exists team_members_email_key;
create unique index if not exists team_members_org_email_key on team_members (organization_id, email);

-- chat_configuration.organization_id replaces the old org_slug-keyed
-- singleton — one config row per organization.
alter table chat_configuration add constraint chat_configuration_organization_id_key unique (organization_id);

-- ── 6. RLS — identical policy set to schema.sql, see that file's header
--       comment for the full public-vs-member-only rationale per table ───
alter table organizations enable row level security;
drop policy if exists "organizations_select_public" on organizations;
drop policy if exists "organizations_insert_self" on organizations;
drop policy if exists "organizations_update_members" on organizations;
create policy "organizations_select_public" on organizations for select using (true);
create policy "organizations_insert_self" on organizations for insert
  with check (auth.uid() is not null and created_by = auth.uid());
create policy "organizations_update_members" on organizations for update using (is_org_member(id));

alter table organization_members enable row level security;
drop policy if exists "organization_members_select" on organization_members;
drop policy if exists "organization_members_insert_owner_bootstrap" on organization_members;
drop policy if exists "organization_members_update_admins" on organization_members;
drop policy if exists "organization_members_delete_admins" on organization_members;
create policy "organization_members_select" on organization_members for select using (is_org_member(organization_id));
create policy "organization_members_insert_owner_bootstrap" on organization_members for insert
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and exists (select 1 from organizations o where o.id = organization_id and o.created_by = auth.uid())
  );
create policy "organization_members_update_admins" on organization_members for update using (is_org_admin(organization_id));
create policy "organization_members_delete_admins" on organization_members for delete using (is_org_admin(organization_id));

alter table organization_invites enable row level security;
drop policy if exists "organization_invites_select_admins" on organization_invites;
drop policy if exists "organization_invites_insert_admins" on organization_invites;
drop policy if exists "organization_invites_update_admins" on organization_invites;
drop policy if exists "organization_invites_delete_admins" on organization_invites;
create policy "organization_invites_select_admins" on organization_invites for select using (is_org_admin(organization_id));
create policy "organization_invites_insert_admins" on organization_invites for insert
  with check (is_org_admin(organization_id) and invited_by = auth.uid());
create policy "organization_invites_update_admins" on organization_invites for update using (is_org_admin(organization_id));
create policy "organization_invites_delete_admins" on organization_invites for delete using (is_org_admin(organization_id));

alter table team_members enable row level security;
drop policy if exists "team_members_select" on team_members;
drop policy if exists "team_members_insert" on team_members;
drop policy if exists "team_members_update" on team_members;
drop policy if exists "team_members_delete" on team_members;
create policy "team_members_select" on team_members for select using (is_org_member(organization_id));
create policy "team_members_insert" on team_members for insert with check (is_org_member(organization_id));
create policy "team_members_update" on team_members for update using (is_org_member(organization_id));
create policy "team_members_delete" on team_members for delete using (is_org_member(organization_id));

alter table forms enable row level security;
drop policy if exists "forms_select" on forms;
drop policy if exists "forms_insert" on forms;
drop policy if exists "forms_update" on forms;
drop policy if exists "forms_delete" on forms;
create policy "forms_select" on forms for select using (true);
create policy "forms_insert" on forms for insert with check (is_org_member(organization_id));
create policy "forms_update" on forms for update using (is_org_member(organization_id));
create policy "forms_delete" on forms for delete using (is_org_member(organization_id));

alter table leads enable row level security;
drop policy if exists "leads_select" on leads;
drop policy if exists "leads_insert" on leads;
drop policy if exists "leads_update" on leads;
drop policy if exists "leads_delete" on leads;
create policy "leads_select" on leads for select using (is_org_member(organization_id));
create policy "leads_insert" on leads for insert with check (true);
create policy "leads_update" on leads for update
  using (is_org_member(organization_id) or chat_session_id is not null)
  with check (is_org_member(organization_id) or chat_session_id is not null);
create policy "leads_delete" on leads for delete using (is_org_member(organization_id));

alter table form_submissions enable row level security;
drop policy if exists "form_submissions_select" on form_submissions;
drop policy if exists "form_submissions_insert" on form_submissions;
drop policy if exists "form_submissions_update" on form_submissions;
drop policy if exists "form_submissions_delete" on form_submissions;
create policy "form_submissions_select" on form_submissions for select using (is_org_member(organization_id));
create policy "form_submissions_insert" on form_submissions for insert with check (true);
create policy "form_submissions_update" on form_submissions for update using (is_org_member(organization_id));
create policy "form_submissions_delete" on form_submissions for delete using (is_org_member(organization_id));

alter table lead_activity enable row level security;
drop policy if exists "lead_activity_select" on lead_activity;
drop policy if exists "lead_activity_insert" on lead_activity;
drop policy if exists "lead_activity_update" on lead_activity;
drop policy if exists "lead_activity_delete" on lead_activity;
create policy "lead_activity_select" on lead_activity for select using (is_org_member(organization_id));
create policy "lead_activity_insert" on lead_activity for insert with check (true);
create policy "lead_activity_update" on lead_activity for update using (is_org_member(organization_id));
create policy "lead_activity_delete" on lead_activity for delete using (is_org_member(organization_id));

alter table chat_configuration enable row level security;
drop policy if exists "chat_configuration_select" on chat_configuration;
drop policy if exists "chat_configuration_insert" on chat_configuration;
drop policy if exists "chat_configuration_update" on chat_configuration;
drop policy if exists "chat_configuration_delete" on chat_configuration;
create policy "chat_configuration_select" on chat_configuration for select using (true);
create policy "chat_configuration_insert" on chat_configuration for insert with check (is_org_member(organization_id));
create policy "chat_configuration_update" on chat_configuration for update using (is_org_member(organization_id));
create policy "chat_configuration_delete" on chat_configuration for delete using (is_org_member(organization_id));

-- ── 7. Verification ───────────────────────────────────────────────────────
select 'organizations' as table_name, count(*) from organizations
union all
select 'team_members (should be unchanged)', count(*) from team_members
union all
select 'forms (should be unchanged)', count(*) from forms
union all
select 'leads (should be unchanged)', count(*) from leads
union all
select 'leads with null organization_id (should be 0)', count(*) from leads where organization_id is null;

-- ── 8. YOU STILL NEED TO RUN THIS — nothing above can do it for you ─────
-- Find your user id: Supabase dashboard → Authentication → Users → click
-- your account → copy the "UID" field. Then uncomment and run:
--
-- insert into organization_members (organization_id, user_id, role)
-- values ((select id from organizations where slug = 'vertice-agency'), '<YOUR-AUTH-UID-HERE>', 'owner');
--
-- Without this, the app will auto-provision a brand-new, EMPTY personal
-- organization for you on next login instead of connecting you to your
-- existing "Vertice Agency" data (see OrganizationProvider's
-- auto-provision-if-no-membership logic) — you'd still be able to use the
-- app, just starting from zero instead of seeing the leads/forms above.
