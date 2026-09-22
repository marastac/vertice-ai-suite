-- Lead AI — Webhooks (first real integration): webhook_configurations +
-- webhook_deliveries, RLS, lead.created trigger, and an atomic claim RPC
-- for the backend worker.
--
-- Run this once in the Supabase project's SQL editor, on a project that
-- already ran schema.sql/migrations-phase8.sql (organizations,
-- organization_members, is_org_member(), is_org_admin(), and the `leads`
-- table already exist). NOT executed by Claude — prepared for manual review
-- and application.
--
-- ── Architecture summary (see the audit this implements for the full
--    reasoning) ────────────────────────────────────────────────────────
-- Every lead-creation path (public form, public chat, manual create) is a
-- direct browser -> Supabase write (INSERT or the upsert_chat_lead() RPC) —
-- none of them go through the Express backend. The only reliable, browser-
-- independent place to observe "a lead was created" is the database itself,
-- so:
--   1. A trigger on `leads` (AFTER INSERT) enqueues a row into
--      `webhook_deliveries` — cheap, transactional, happens no matter which
--      of the 4 code paths caused the insert, and never depends on any
--      browser tab staying open.
--   2. The trigger does NOT make any HTTP call and does NOT use pg_net —
--      it only writes a row. Actual delivery (HTTP, HMAC signing, SSRF
--      checks, retries) happens in the existing Express backend (Railway),
--      which polls this table with claim_webhook_deliveries() below.
--   3. Priority requirement: a failure anywhere in the webhook subsystem
--      must never prevent a lead from being saved. notify_lead_created()
--      wraps its own body in BEGIN...EXCEPTION WHEN OTHERS (see its own
--      comment below for the full reasoning) so this holds structurally,
--      not just by the absence of an obvious failure path.
--
-- This script is purely additive — it does not touch any existing table,
-- policy, or row of data outside the two new tables. Safe to re-run
-- (drop-if-exists/create and add-column-if-not-exists are all idempotent).

-- ── 1. webhook_configurations ────────────────────────────────────────────
-- One row per organization (UNIQUE organization_id enforces this at the
-- constraint level, not just by convention).
create table if not exists webhook_configurations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  url text not null,
  is_active boolean not null default false,
  -- HMAC signing secret. Generated server-side (crypto.randomBytes) by the
  -- Express backend, never chosen by the user and never sent back to the
  -- browser after creation — see the RLS note below for why there is
  -- deliberately no SELECT policy on this table for anon/authenticated at
  -- all, not just a "the frontend doesn't ask for this column" convention.
  secret text not null,
  created_by uuid, -- always NULL until a later phase wires it to auth.uid() on insert, same as every other table's created_by
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── 2. webhook_deliveries ────────────────────────────────────────────────
-- The outbox/log. One row per event attempt.
create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  -- Denormalized from webhook_configurations.organization_id, same pattern
  -- as form_submissions.organization_id/lead_activity.organization_id —
  -- lets RLS/indexes filter without a join.
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Nullable + ON DELETE SET NULL (not CASCADE): deleting the webhook
  -- configuration must not erase the delivery history/audit trail for
  -- events that already happened under it — `payload` already holds a
  -- full snapshot of the lead at creation time, so the row stays
  -- meaningful even once this reference is gone. See
  -- server/src/services/webhook-worker.ts's handling of a null
  -- webhook_configuration_id on an in-flight delivery for what this
  -- means operationally.
  webhook_configuration_id uuid references webhook_configurations(id) on delete set null,
  event_type text not null check (event_type in ('lead.created')), -- widen this check when lead.qualified is added
  -- Nullable + ON DELETE SET NULL for the same audit-trail reason as
  -- webhook_configuration_id above — deleting a lead (an owner/admin
  -- action already available in /leads) must not silently wipe the record
  -- of whether Lead AI ever notified an external system about it.
  lead_id uuid references leads(id) on delete set null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'delivered', 'failed')),
  attempts integer not null default 0,
  -- Dual purpose, only one applies at a time depending on `status`:
  --  - status = 'pending':    "don't attempt again before this time" (backoff)
  --  - status = 'processing': unused; see `locked_at` for the processing lease
  next_attempt_at timestamptz,
  -- Lease for `processing` rows — when a worker claims a batch it stamps
  -- locked_at = now(); claim_webhook_deliveries() below treats a
  -- `processing` row whose lease has expired (locked_at older than the
  -- lease duration) as abandoned (e.g. the Railway process restarted
  -- mid-delivery) and reclaims it, so nothing stays stuck in `processing`
  -- forever.
  locked_at timestamptz,
  last_attempted_at timestamptz,
  -- Short, sanitized reason only (e.g. "timeout", "http_500", "dns_error")
  -- — NEVER the destination's response body, and NEVER anything that could
  -- contain the signing secret. See server/src/services/webhook-delivery-service.ts.
  last_error text,
  response_status integer,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

-- Worker's claim query: pending rows ready for (re)attempt, ordered oldest
-- first.
create index if not exists webhook_deliveries_status_next_attempt_idx
  on webhook_deliveries (status, next_attempt_at);
-- Future per-organization delivery history view.
create index if not exists webhook_deliveries_organization_id_idx
  on webhook_deliveries (organization_id);
-- Occasional lookup: "did this lead already get a delivery enqueued".
create index if not exists webhook_deliveries_lead_id_idx
  on webhook_deliveries (lead_id);

-- ── 3. RLS: webhook_configurations ───────────────────────────────────────
alter table webhook_configurations enable row level security;
drop policy if exists "webhook_configurations_insert_admins" on webhook_configurations;
drop policy if exists "webhook_configurations_update_admins" on webhook_configurations;
drop policy if exists "webhook_configurations_delete_admins" on webhook_configurations;

-- Deliberately NO select policy for anon/authenticated here — see the
-- doc comment on the `secret` column above. This is stronger than "the
-- column is just never selected by the app": with zero SELECT policy on
-- this table, a direct REST call from any signed-in user (any role, any
-- organization) returns zero rows, full stop — there is no row-level
-- condition to get right or accidentally weaken later. The ONLY reader is
-- the Express backend, using the service_role key (which bypasses RLS
-- entirely by design), which strips `secret` before ever building a JSON
-- response for the browser — see server/src/repositories/webhook-repository.ts's
-- toPublicConfig(). member/viewer's "read-only" view in /integrations is
-- served by a backend endpoint for this same reason, not a direct
-- Supabase read — see GET /api/webhooks/config.
--
-- INSERT/UPDATE/DELETE: owner/admin only (is_org_admin), same threshold as
-- chat_configuration/forms/organizations after their own role-permission
-- fixes. In practice these are also always executed by the backend using
-- service_role, which bypasses RLS — these policies exist as defense in
-- depth (documented project convention: RLS is the real boundary, never
-- assume the only caller will always be the trusted backend) and so a
-- future direct-frontend write path, if one is ever added, is safe by
-- default. WITH CHECK mirrors USING on UPDATE, same reasoning as every
-- other *_update_members-style policy in this project: without it, an
-- admin could UPDATE a row they're authorized to touch and, in the same
-- statement, move it to a different organization_id by also changing
-- webhook_configuration's implicit "owner" (its own organization_id) —
-- WITH CHECK (is_org_admin(organization_id)) evaluated against the *new*
-- row closes that.
create policy "webhook_configurations_insert_admins" on webhook_configurations for insert
  with check (is_org_admin(organization_id));
create policy "webhook_configurations_update_admins" on webhook_configurations for update
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));
create policy "webhook_configurations_delete_admins" on webhook_configurations for delete
  using (is_org_admin(organization_id));

-- ── 4. RLS: webhook_deliveries ───────────────────────────────────────────
alter table webhook_deliveries enable row level security;
drop policy if exists "webhook_deliveries_select" on webhook_deliveries;

-- SELECT: any organization member (including viewer) — prepared for a
-- future delivery-history view in /integrations, not used by the frontend
-- yet. No payload/secret sensitivity concern here: `payload` only contains
-- the same lead fields a member can already see on /leads.
create policy "webhook_deliveries_select" on webhook_deliveries for select
  using (is_org_member(organization_id));

-- Deliberately NO insert/update/delete policy for anon/authenticated.
-- Only two things ever write this table: the `leads` trigger below (runs
-- SECURITY DEFINER, bypasses RLS regardless of who caused the triggering
-- INSERT — see the trigger's own comment for why that matters for the two
-- anonymous lead-creation paths) and the Express backend's worker (uses
-- the service_role key, which bypasses RLS independently of any policy
-- here). No signed-in user, at any role, should ever be able to mark a
-- delivery "delivered" or alter its payload directly.

-- ── 5. lead.created trigger ──────────────────────────────────────────────
-- SECURITY DEFINER is required here, not optional: a trigger function
-- without it runs with the privileges of whoever caused the triggering
-- statement. Two of the four lead-creation paths (the public form and the
-- public chat) insert into `leads` as the anonymous `anon` role — under
-- that role this function's own SELECT on webhook_configurations and
-- INSERT into webhook_deliveries would themselves be evaluated against
-- RLS and rejected (neither table grants anon/authenticated any access —
-- see above), silently breaking webhook delivery for exactly the two
-- highest-volume creation paths. SECURITY DEFINER (owned by the role that
-- ran this script) sidesteps that, matching the same pattern already used
-- by upsert_chat_lead()/create_public_chat_session() elsewhere in this
-- project for the identical reason.
--
-- IMPORTANT — why the body is wrapped in BEGIN...EXCEPTION WHEN OTHERS:
-- an AFTER INSERT trigger runs inside the SAME transaction as the
-- triggering INSERT. Any unhandled exception here — a transient Supabase/
-- Postgres error writing webhook_deliveries, a lock conflict, a foreign key
-- race if webhook_configurations is deleted in the same instant — would
-- roll back that entire transaction, taking the lead INSERT down with it.
-- That directly violates this project's priority requirement: a failure of
-- the webhook subsystem must never prevent a lead from being saved. The
-- inner BEGIN/EXCEPTION block scopes a WHEN OTHERS handler around only the
-- enqueue logic (never around the leads INSERT itself, which has already
-- succeeded by the time this AFTER trigger fires) and always falls through
-- to `return NEW` — with or without a webhook configured, with or without
-- an error along the way, the lead is always saved. WHEN OTHERS is broad
-- by design here, not an oversight: this function's entire job is best-
-- effort side-channel notification, so swallowing any error it can
-- possibly raise is exactly the intended behavior, not a masking risk —
-- there is no other operation in this function whose failure would need
-- to be surfaced differently. RAISE WARNING (not a table write, so it
-- can't itself fail for the same underlying reason an INSERT might) sends
-- the failure to the Postgres server log (visible in Supabase's Logs
-- Explorer) with the lead/organization id and SQLERRM/SQLSTATE only —
-- deliberately never the signing secret (not in scope here at all) and
-- never the full payload (which could contain the lead's email/phone/notes).
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

    -- No active webhook for this organization — nothing to enqueue.
    if v_config.id is not null then
      -- Minted explicitly, before building the payload, specifically so
      -- event_id (inside the JSON) and this row's own `id` column are
      -- guaranteed identical — the same "mint the id client/trigger-side
      -- before it exists as a row" pattern lead-supabase-repository.ts::create()
      -- already uses for the same kind of chicken-and-egg ordering problem.
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
      -- Minimal, sanitized diagnostic only — lead id, organization id, the
      -- error code, and Postgres's own short error message. Never the
      -- payload, never anything from webhook_configurations (i.e. never
      -- `secret`). See the function-level comment above for why WHEN
      -- OTHERS is the correct scope here.
      raise warning 'notify_lead_created: failed to enqueue webhook delivery for lead % (org %): % (SQLSTATE %)',
        NEW.id, NEW.organization_id, SQLERRM, SQLSTATE;
  end;

  -- Reached unconditionally — whether a webhook was configured, whether
  -- the enqueue succeeded, or whether it hit the exception handler above:
  -- the lead this trigger fired for is always saved.
  return NEW;
end;
$$;

-- EXECUTE is granted to PUBLIC by default when a function is created —
-- revoking it here is defense-in-depth hygiene, not a functional
-- requirement: PostgreSQL trigger firing is governed by the trigger's
-- existence on the table plus the caller's INSERT privilege on `leads`
-- (itself gated by leads_insert's RLS policy), never by EXECUTE on the
-- trigger function. PostgreSQL also independently refuses to invoke any
-- `returns trigger` function outside of actual trigger context ("trigger
-- functions can only be called as triggers"), so this function could not
-- be called directly even with EXECUTE still granted. Revoking it anyway
-- keeps this function's grants as narrow as its actual (zero) direct
-- callers, consistent with claim_webhook_deliveries() below.
revoke execute on function notify_lead_created() from public;

drop trigger if exists leads_notify_webhook on leads;
create trigger leads_notify_webhook
  after insert on leads
  for each row
  execute function notify_lead_created();

-- ── 6. claim_webhook_deliveries(): atomic worker claim ──────────────────
-- Why this needs to be a single SQL statement, not "SELECT pending then
-- UPDATE": a plain select-then-update from the Express worker is a
-- classic double-claim race — two ticks of the poll loop (or, later, two
-- Railway instances) could both SELECT the same pending rows before either
-- has UPDATEd them, and both would attempt delivery. `FOR UPDATE SKIP
-- LOCKED` inside a single UPDATE statement is Postgres's built-in answer:
-- each concurrent caller only ever sees rows the other hasn't already
-- locked, atomically, in the same statement that marks them claimed.
--
-- One statement also claims BOTH genuinely-new pending rows (whose
-- next_attempt_at has arrived, or was never set) AND abandoned
-- `processing` rows whose lease (locked_at) expired — e.g. because the
-- Railway process restarted mid-delivery. Nothing here can stay stuck in
-- `processing` forever.
--
-- Attempts is incremented at claim time (this call IS the attempt being
-- made), and last_attempted_at/locked_at are stamped together — the
-- caller (webhook-worker.ts) fills in the real outcome afterward via a
-- separate, ordinary UPDATE keyed by id once delivery finishes.
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

-- Only the Express backend (service_role) is expected to call this. No
-- `revoke ... from public` elsewhere in this project's RPCs is done when
-- an anonymous caller legitimately needs the function (is_org_editor,
-- is_org_member, etc.) — this one has no such need, so it's revoked from
-- PUBLIC outright and only re-granted to service_role.
revoke all on function claim_webhook_deliveries(integer, integer) from public;
grant execute on function claim_webhook_deliveries(integer, integer) to service_role;

-- ── verification ──────────────────────────────────────────────────────────
-- 1) Confirm both tables and their indexes/constraints exist.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_name in ('webhook_configurations', 'webhook_deliveries')
order by table_name, ordinal_position;

-- 2) Confirm RLS policies match the design above.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in ('webhook_configurations', 'webhook_deliveries')
order by tablename, policyname;

-- 3) Confirm the trigger and claim function exist with the right security
--    context, and that notify_lead_created()'s EXECUTE was actually
--    revoked from PUBLIC (proacl should show it explicitly narrowed, not
--    left at the default).
select tgname, tgrelid::regclass, tgenabled from pg_trigger where tgname = 'leads_notify_webhook';
select proname, prosecdef, proacl from pg_proc where proname in ('notify_lead_created', 'claim_webhook_deliveries');

-- 4) Confirm webhook_deliveries.lead_id / webhook_configuration_id are
--    nullable (query 1 above already shows this via is_nullable, repeated
--    here for a quick standalone check).
select column_name, is_nullable
from information_schema.columns
where table_name = 'webhook_deliveries' and column_name in ('lead_id', 'webhook_configuration_id');

-- 5) Manual smoke test (after the Express backend is deployed with a real
--    webhook_configurations row, is_active = true, pointing at e.g.
--    https://webhook.site/<your-id>):
--      - Submit a public form (/f/:formId) or complete a public chat
--        qualification (/c/:orgSlug) for that organization — a row should
--        appear in webhook_deliveries within moments (status starts
--        'pending', then 'processing', then 'delivered' once the worker
--        picks it up).
--      - Create a lead manually from /leads as a signed-in user — same
--        expected result.
--      - As a signed-in 'member'/'viewer', attempt a direct REST call:
--        `select * from webhook_configurations` should return the secret
--        column to nobody — not even a row — since there's no SELECT
--        policy at all for authenticated users on this table.
--      - As a signed-in 'member'/'viewer', attempt to UPDATE
--        webhook_configurations directly — should fail with an RLS policy
--        violation. As 'owner'/'admin' of a DIFFERENT organization,
--        attempting to UPDATE another organization's row should also fail.
--      - Delete a lead that already has a webhook_deliveries row (as
--        owner/admin, from /leads) — the delivery row must still exist
--        afterward with lead_id now NULL, not disappear. Same check
--        deleting the organization's webhook_configurations row (no UI for
--        this yet; delete it directly as project owner) while a delivery
--        for it still exists — webhook_configuration_id should become
--        NULL, the row should still exist, and the backend worker should
--        mark it 'failed' with last_error = 'webhook_config_deleted' on
--        its next claim, not crash or retry forever.
