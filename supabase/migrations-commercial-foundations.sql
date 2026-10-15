-- MAASTAC AI (técnicamente "Lead AI") — Cimientos comerciales (Fase 5):
-- asignación MANUAL y auditada de planes + consulta de consumo para un futuro
-- panel del cliente. NO activa ningún plan, NO cambia precios, límites ni
-- cuotas reales y NO implementa cobros: solo prepara las piezas seguras.
--
-- 1. plan_assignments: registro inmutable de cada cambio de plan (quién,
--    cuándo, por qué y con qué referencia de pago manual). Solo service_role.
-- 2. assign_organization_plan(): única vía prevista para cambiar el plan o el
--    modo de una organización tras un cobro manual. Solo service_role (se
--    ejecuta desde el SQL editor o un futuro panel interno, nunca desde el
--    navegador del cliente). Rechaza pasar a 'enforce' si los límites
--    efectivos no están configurados (evita denegar todo por error) y nunca
--    toca los contadores de consumo.
-- 3. get_my_organization_usage(): consumo del mes para el OWNER/ADMIN de la
--    organización (porcentajes y conversaciones; nunca importes, precios ni
--    micro-USD). Para el futuro panel de consumo.
--
-- Requiere migrations-usage-quotas.sql. Re-ejecutable. NO ejecutada contra
-- ninguna base real. Pruebas: supabase/tests-commercial-foundations.sql.

create table if not exists public.plan_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  previous_plan_code text,
  new_plan_code text not null references public.plans(code) on update cascade on delete restrict,
  previous_mode text,
  new_mode text not null check (new_mode in ('off', 'shadow', 'enforce')),
  reason text not null check (length(trim(reason)) >= 3),
  assigned_by text not null check (length(trim(assigned_by)) >= 3),
  payment_reference text,
  created_at timestamptz not null default now()
);
create index if not exists plan_assignments_organization_id_idx
  on public.plan_assignments (organization_id, created_at desc);

alter table public.plan_assignments enable row level security;
revoke all on table public.plan_assignments from anon, authenticated;
grant select, insert on table public.plan_assignments to service_role;

create or replace function public.assign_organization_plan(
  p_organization_id uuid,
  p_plan_code text,
  p_mode text,
  p_reason text,
  p_assigned_by text,
  p_payment_reference text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set lock_timeout = '2s'
as $$
declare
  v_quota public.organization_quotas;
  v_plan public.plans;
  v_previous_plan text;
  v_previous_mode text;
begin
  if p_organization_id is null or p_plan_code is null or p_mode is null then
    raise exception 'PLAN_INVALID_ARGUMENT';
  end if;
  if p_mode not in ('off', 'shadow', 'enforce') then
    raise exception 'PLAN_INVALID_MODE';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 3 or coalesce(length(trim(p_assigned_by)), 0) < 3 then
    raise exception 'PLAN_AUDIT_FIELDS_REQUIRED';
  end if;
  if not exists (select 1 from public.organizations where id = p_organization_id) then
    raise exception 'PLAN_ORGANIZATION_NOT_FOUND';
  end if;
  select * into v_plan from public.plans where code = p_plan_code;
  if v_plan.code is null then
    raise exception 'PLAN_NOT_FOUND';
  end if;

  -- Same per-organization lock reserve_chat_usage() takes: no message is
  -- being metered for this organization while its plan changes.
  select * into v_quota from public.organization_quotas where organization_id = p_organization_id for update;
  v_previous_plan := v_quota.plan_code;
  v_previous_mode := v_quota.enforcement_mode;

  -- Never switch to enforce with limits that would deny everything.
  if p_mode = 'enforce'
     and (coalesce(v_quota.conversation_limit_override, v_plan.monthly_conversation_limit) is null
          or coalesce(v_quota.budget_micros_override, v_plan.monthly_budget_micros) is null) then
    raise exception 'PLAN_LIMITS_NOT_CONFIGURED';
  end if;

  insert into public.organization_quotas (organization_id, plan_code, enforcement_mode)
  values (p_organization_id, p_plan_code, p_mode)
  on conflict (organization_id) do update set
    plan_code = excluded.plan_code,
    enforcement_mode = excluded.enforcement_mode,
    updated_at = now();

  insert into public.plan_assignments (organization_id, previous_plan_code, new_plan_code, previous_mode, new_mode, reason, assigned_by, payment_reference)
  values (p_organization_id, v_previous_plan, p_plan_code, v_previous_mode, p_mode, trim(p_reason), trim(p_assigned_by), nullif(trim(p_payment_reference), ''));

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'previous_plan', v_previous_plan,
    'plan', p_plan_code,
    'previous_mode', v_previous_mode,
    'mode', p_mode
  );
end;
$$;

revoke all on function public.assign_organization_plan(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.assign_organization_plan(uuid, text, text, text, text, text) to service_role;

-- Consumo del mes en curso para el owner/admin. SECURITY DEFINER porque las
-- tablas de cuotas no son legibles por authenticated; por eso valida
-- is_org_admin() ANTES de leer nada y solo devuelve campos agregados.
create or replace function public.get_my_organization_usage(p_organization_id uuid)
returns table (
  plan_name text,
  period_start date,
  conversations_used integer,
  conversation_limit integer,
  messages_used integer,
  budget_used_percent integer,
  limits_configured boolean,
  status text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not public.is_org_admin(p_organization_id) then
    raise exception 'NOT_ADMIN' using errcode = '42501';
  end if;

  return query
  select
    p.display_name,
    date_trunc('month', (now() at time zone 'utc'))::date,
    coalesce(u.conversations_used, 0),
    coalesce(q.conversation_limit_override, p.monthly_conversation_limit),
    coalesce(u.messages_used, 0),
    case
      when coalesce(q.budget_micros_override, p.monthly_budget_micros) is null then null
      when coalesce(q.budget_micros_override, p.monthly_budget_micros) = 0 then 100
      else least(100, ceil(100.0 * (coalesce(u.settled_micros, 0) + coalesce(u.reserved_micros, 0))
                             / coalesce(q.budget_micros_override, p.monthly_budget_micros)))::integer
    end,
    coalesce(q.conversation_limit_override, p.monthly_conversation_limit) is not null
      and coalesce(q.budget_micros_override, p.monthly_budget_micros) is not null,
    coalesce(q.status, 'active')
  from (select p_organization_id as id) o
  left join public.organization_quotas q on q.organization_id = o.id
  left join public.plans p on p.code = q.plan_code
  left join public.usage_periods u
    on u.organization_id = o.id and u.period_start = date_trunc('month', (now() at time zone 'utc'))::date;
end;
$$;

revoke all on function public.get_my_organization_usage(uuid) from public, anon;
grant execute on function public.get_my_organization_usage(uuid) to authenticated;

-- ── verificación (solo lectura) ────────────────────────────────────────────
select proname, prosecdef,
       has_function_privilege('anon', oid, 'execute') as anon,
       has_function_privilege('authenticated', oid, 'execute') as authenticated,
       has_function_privilege('service_role', oid, 'execute') as service_role
from pg_proc
where pronamespace = 'public'::regnamespace and proname in ('assign_organization_plan', 'get_my_organization_usage');

-- ── reversión (NO ejecutar salvo que se quiera deshacer) ───────────────────
-- drop function if exists public.get_my_organization_usage(uuid);
-- drop function if exists public.assign_organization_plan(uuid, text, text, text, text, text);
-- drop table if exists public.plan_assignments;  -- borra el historial de asignaciones
