-- Lead AI — public chat lead-upsert RPC (bug fix, existing project)
--
-- Run this once in the Supabase project's SQL editor. Adds ONE new function,
-- upsert_chat_lead(), and grants anon/authenticated permission to call it.
-- No existing table, column, or RLS policy is modified — this is purely
-- additive. Safe to re-run (create or replace + grant are both idempotent).
--
-- Why this is needed: the public chat page (/c/:orgSlug) creates/updates a
-- Lead by chat_session_id as the conversation progresses
-- (qualification-service.ts::syncLeadFromQualification ->
-- activeLeadRepository.upsertByChatSession()). That code used to upsert the
-- row via PostgREST and then SELECT it back to return it to the caller and
-- to decide which activity message to log. The SELECT always failed for an
-- anonymous visitor — leads_select/lead_activity_select require
-- is_org_member(organization_id), which is unconditionally false with no
-- auth.uid() — so the visitor's own successful write could never be read
-- back, and the whole call threw. This function performs the upsert, the
-- lead_activity insert, and the read in ONE security definer call, so RLS
-- never needs to gate a read-after-write the anonymous caller was already
-- authorized to make (leads_insert is `with check (true)`; leads_update
-- already allows an anonymous caller when chat_session_id is not null,
-- which this function always sets; lead_activity_insert is already
-- public). It returns only the exact row this call just wrote — anon still
-- has no way to list or fetch an arbitrary lead.

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

-- ── verification ──────────────────────────────────────────────────────────
select proname, proacl from pg_proc where proname = 'upsert_chat_lead';
-- Expect one row. proacl should list execute grants for anon and
-- authenticated (shown as role oids, e.g. "=X/postgres" entries).
