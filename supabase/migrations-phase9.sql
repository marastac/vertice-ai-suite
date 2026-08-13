-- Lead AI — Phase 9 upgrade script for an EXISTING project
--
-- Use this if your Supabase project already ran schema.sql and
-- migrations-phase8.sql. Adds the two columns that drive the new
-- one-time onboarding screen (`/onboarding`) and immediately backfills
-- every existing organization as "already onboarded" — nobody who already
-- uses the app is interrupted by the new screen; only organizations
-- created after this point will ever see it. Safe to re-run.
--
-- If you're setting up a brand-new project instead, just run schema.sql
-- (already includes these columns) — do not run this file against a fresh
-- project that has no organizations yet.

alter table organizations add column if not exists
  business_type text check (business_type in ('content_creator', 'course_creator', 'online_business'));
alter table organizations add column if not exists onboarding_completed_at timestamptz;

-- Every organization that exists right now predates the onboarding screen —
-- treat all of them as already completed, using their own created_at as a
-- plausible "completed" timestamp rather than "now" for every row.
update organizations set onboarding_completed_at = created_at where onboarding_completed_at is null;

-- ── verification ──────────────────────────────────────────────────────────
select 'organizations' as table_name, count(*) as total,
  count(*) filter (where onboarding_completed_at is not null) as already_onboarded,
  count(*) filter (where onboarding_completed_at is null) as will_see_onboarding
from organizations;
-- Expect will_see_onboarding = 0 right after running this. From this point
-- forward, only organizations created via the app's normal sign-up flow
-- (OrganizationProvider's auto-provisioning) will have a NULL
-- onboarding_completed_at, and therefore see /onboarding once.
