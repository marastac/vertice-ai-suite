-- MAASTAC AI (técnicamente "Lead AI") — Cuotas mensuales por organización, Fase 1.
--
-- Alcance: ÚNICAMENTE estructura inerte. Seis tablas, un helper de costo,
-- tres funciones RPC, un trigger que da cuota a cada organización nueva y
-- una función de conciliación de reservas abandonadas (sección 14). NADA del backend ni del frontend las usa todavía — la
-- conexión con el chat es la Fase 2/3, que requiere autorización aparte.
--
-- Puramente aditiva: no altera ninguna tabla, política, trigger ni función
-- existente. Depende solo de `organizations` (schema.sql / migrations-phase8.sql),
-- a la que AÑADE un trigger AFTER INSERT nuevo (sección 13) que crea la fila
-- de cuota de cada organización nueva; no modifica sus columnas, políticas
-- ni triggers existentes.
--
-- NO ejecutada contra Supabase — preparada para revisión y aplicación manual
-- en el SQL editor, igual que el resto de migraciones de este proyecto. El
-- SQL editor ejecuta todo el script como una sola transacción implícita: si
-- cualquier sentencia falla, no queda nada a medias.
--
-- ── Compatibilidad ──────────────────────────────────────────────────────────
-- Toda organización existente recibe una fila en organization_quotas con
-- enforcement_mode = 'off'. Con 'off', reserve_chat_usage() devuelve
-- allowed=true SIN escribir nada. Toda organización creada DESPUÉS de
-- aplicar esta migración recibe su fila automáticamente, en modo 'shadow'
-- (registra consumo, nunca bloquea), mediante el trigger de la sección 13.
-- Una organización que aun así no tenga fila devuelve mode='unconfigured'
-- y allowed=false (reason 'quota_not_configured'): sin fila nunca hay
-- acceso ilimitado. Ningún plan tiene límites definidos (todos NULL) y
-- ninguno está activo. Ningún precio de modelo se siembra: model_prices
-- queda vacía hasta que se carguen desde el panel oficial.
--
-- ── Decisiones de diseño (ver el informe de la Fase 1) ──────────────────────
-- * ATOMICIDAD: reserve_chat_usage() evalúa TODAS las condiciones antes de
--   escribir nada. Una denegación en modo 'enforce' retorna sin haber
--   ejecutado ningún INSERT/UPDATE — no hay nada que revertir. Retornar
--   normalmente desde una función COMPROMETE lo escrito (no hay rollback
--   implícito por "denegar"), por eso la regla es "decidir primero, escribir
--   después", no "escribir y deshacer". Cualquier error inesperado lanza una
--   excepción, que aborta la transacción completa de la llamada RPC.
-- * IDEMPOTENCIA: p_request_id (uuid generado por el backend, uno por mensaje)
--   es UNIQUE en usage_reservations. Un reintento con el mismo id devuelve la
--   reserva existente sin volver a cobrar. settle_chat_usage() solo actúa
--   sobre reservas en estado 'reserved'; una segunda liquidación es no-op.
-- * CONCURRENCIA: cada reserva/liquidación bloquea la fila de
--   organization_quotas de ESA organización (SELECT ... FOR UPDATE). Dos
--   solicitudes de la misma organización se serializan; organizaciones
--   distintas bloquean filas distintas y nunca se esperan entre sí. Orden de
--   bloqueo fijo en ambas funciones (organization_quotas → usage_reservations
--   → usage_periods) para evitar deadlocks.
-- * CAMBIO DE MES (UTC): el periodo es date_trunc('month', now() UTC). Una
--   reserva pertenece al periodo en que se CREÓ; su liquidación se aplica a
--   ese mismo periodo aunque ocurra en el mes siguiente. Una conversación se
--   cuenta UNA sola vez, en el periodo de su primer mensaje reservado; si
--   continúa en el mes siguiente, sus mensajes consumen presupuesto y
--   contador de mensajes del mes nuevo, pero no vuelve a contar como
--   conversación.
-- * COSTOS: micro-USD (bigint, 1 USD = 1.000.000). Precios por millón de
--   tokens en model_prices, cargados a mano. La reserva usa una COTA SUPERIOR
--   que calcula el backend (tokens de entrada estimados por exceso + suma de
--   max_tokens de salida); la liquidación reemplaza esa estimación por el
--   costo real. Una reserva nunca liquidada sigue contando con su estimación
--   — nunca libera presupuesto por accidente.
-- * SEGURIDAD: funciones SECURITY INVOKER (no DEFINER): solo service_role
--   puede ejecutarlas, y service_role ya omite RLS. Si algún día se otorgara
--   EXECUTE por error a anon/authenticated, las funciones correrían con SUS
--   privilegios y RLS (sin políticas) rechazaría toda escritura. EXECUTE se
--   revoca de PUBLIC, anon y authenticated. Las seis tablas tienen RLS
--   activado y CERO políticas, más REVOKE ALL explícito a anon/authenticated
--   (también cubre TRUNCATE, que RLS no controla). search_path fijado y
--   nombres calificados con `public.`.

-- ── 1. plans: catálogo de planes (sin precios) ─────────────────────────────
-- Límites NULL = "no configurado". En modo 'enforce', un límite mensual NULL
-- DENIEGA (falla cerrado). hourly_message_cap NULL = sin tope por hora.
create table if not exists public.plans (
  code text primary key check (code ~ '^[a-z0-9_]{2,40}$'),
  display_name text not null,
  monthly_conversation_limit integer check (monthly_conversation_limit >= 0),
  monthly_budget_micros bigint check (monthly_budget_micros >= 0),
  -- Límite TÉCNICO anti-ráfaga (mensajes reservados por organización en la
  -- última hora). Se guarda aquí por comodidad, no es un atributo comercial.
  hourly_message_cap integer check (hourly_message_cap > 0),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.plans (code, display_name) values
  ('pilot', 'Piloto'),
  ('starter', 'Starter'),
  ('professional', 'Professional'),
  ('business', 'Business')
on conflict (code) do nothing;

-- ── 2. organization_quotas: plan y modo de cada organización ───────────────
create table if not exists public.organization_quotas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plan_code text references public.plans(code) on update cascade on delete restrict,
  conversation_limit_override integer check (conversation_limit_override >= 0),
  budget_micros_override bigint check (budget_micros_override >= 0),
  hourly_message_cap_override integer check (hourly_message_cap_override > 0),
  status text not null default 'active' check (status in ('active', 'suspended')),
  enforcement_mode text not null default 'off' check (enforcement_mode in ('off', 'shadow', 'enforce')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Compatibilidad: toda organización existente queda en 'off' (sin efecto).
-- Solo en la PRIMERA aplicación (tabla aún vacía): si este script se
-- re-ejecuta más adelante, una organización que hubiera quedado sin fila
-- (p. ej. porque falló el trigger de la sección 13) debe seguir DENEGADA,
-- no recibir 'off' = acceso ilimitado por accidente.
insert into public.organization_quotas (organization_id, plan_code, enforcement_mode)
select id, 'pilot', 'off' from public.organizations
where not exists (select 1 from public.organization_quotas)
on conflict (organization_id) do nothing;

-- ── 3. model_prices: precio por modelo, cargado a mano ─────────────────────
-- Vacía a propósito. Micro-USD por MILLÓN de tokens (p. ej. US$1/MTok =
-- 1000000). Valores tomados SOLO de la página oficial de precios de
-- Anthropic; ver el procedimiento en DISENO_RIESGO_3.txt (capítulo 4) y las
-- consultas de control en monitoring-usage-quotas.sql.
create table if not exists public.model_prices (
  model text primary key check (length(trim(model)) > 0),
  input_micros_per_mtok bigint not null check (input_micros_per_mtok >= 0),
  output_micros_per_mtok bigint not null check (output_micros_per_mtok >= 0),
  -- Procedencia (obligatoria, ver restricciones abajo): de dónde salió el
  -- precio y qué día se comprobó. Nunca un valor sin fuente.
  source_url text,
  verified_on date,
  updated_at timestamptz not null default now()
);

-- Re-ejecución sobre una tabla creada por una versión anterior de este
-- script: añade las columnas de procedencia si faltan.
alter table public.model_prices add column if not exists source_url text;
alter table public.model_prices add column if not exists verified_on date;

-- Restricciones de sanidad (con nombre propio, recreables al re-ejecutar).
-- Si una fila existente las incumple, el script FALLA a propósito: hay que
-- corregir esa fila (con su fuente oficial) antes de continuar.
--  * Identificador exacto como lo usa la API: minúsculas, sin espacios.
--    Rechaza 'Claude-Opus-4-8', ' claude-opus-4-8', 'claude opus'.
--  * Rango plausible por MILLÓN de tokens: US$0,01 a US$1.000/MTok. Bloquea
--    errores de unidades (un precio cargado "en USD" o "por token", p. ej.
--    5, haría el costo ≈ 0 y el presupuesto nunca se agotaría).
--  * Procedencia: URL https de un dominio de Anthropic (anthropic.com o
--    claude.com) y fecha de verificación.
alter table public.model_prices drop constraint if exists model_prices_model_format_check;
alter table public.model_prices add constraint model_prices_model_format_check
  check (model ~ '^[a-z0-9][a-z0-9._-]{1,99}$');
alter table public.model_prices drop constraint if exists model_prices_input_range_check;
alter table public.model_prices add constraint model_prices_input_range_check
  check (input_micros_per_mtok between 10000 and 1000000000);
alter table public.model_prices drop constraint if exists model_prices_output_range_check;
alter table public.model_prices add constraint model_prices_output_range_check
  check (output_micros_per_mtok between 10000 and 1000000000);
alter table public.model_prices drop constraint if exists model_prices_source_url_check;
alter table public.model_prices add constraint model_prices_source_url_check
  check (source_url is not null and source_url ~ '^https://([a-z0-9-]+\.)*(anthropic\.com|claude\.com)(/|$)');
alter table public.model_prices drop constraint if exists model_prices_verified_on_check;
alter table public.model_prices add constraint model_prices_verified_on_check
  check (verified_on is not null);

-- ── 4. usage_periods: contadores por organización y mes (UTC) ──────────────
create table if not exists public.usage_periods (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_start date not null check (extract(day from period_start) = 1),
  conversations_used integer not null default 0 check (conversations_used >= 0),
  messages_used integer not null default 0 check (messages_used >= 0),
  -- Suma de estimated_micros de reservas aún 'reserved' de este periodo.
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  -- Suma de actual_micros de reservas ya liquidadas de este periodo.
  settled_micros bigint not null default 0 check (settled_micros >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, period_start)
);

-- ── 5. usage_conversations: cada sesión cuenta una sola vez ────────────────
create table if not exists public.usage_conversations (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Mismo id que genera el backend Express (randomUUID()); sin FK hacia
  -- chat_sessions por la misma razón documentada en usage_events.
  session_id uuid not null,
  period_start date not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, session_id)
);

-- ── 6. usage_reservations: ledger, una fila por mensaje ────────────────────
create table if not exists public.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_id uuid not null,
  period_start date not null,
  enforcement_mode text not null check (enforcement_mode in ('shadow', 'enforce')),
  model text not null,
  estimated_input_tokens integer not null check (estimated_input_tokens >= 0),
  max_output_tokens integer not null check (max_output_tokens >= 0),
  -- Copia de los precios usados al reservar (auditable aunque cambien después).
  input_micros_per_mtok bigint not null check (input_micros_per_mtok >= 0),
  output_micros_per_mtok bigint not null check (output_micros_per_mtok >= 0),
  estimated_micros bigint not null check (estimated_micros >= 0),
  -- Solo en modo 'shadow': la razón por la que 'enforce' habría denegado.
  shadow_would_deny text,
  status text not null default 'reserved' check (status in ('reserved', 'settled')),
  actual_input_tokens integer check (actual_input_tokens >= 0),
  actual_output_tokens integer check (actual_output_tokens >= 0),
  actual_model text,
  actual_micros bigint check (actual_micros >= 0),
  -- 'actual': tokens y precio reales. 'estimated': uso real desconocido,
  -- se conserva la estimación. 'reservation_price': tokens reales pero el
  -- modelo informado no tiene precio — se usa el mayor entre la estimación
  -- y los tokens reales a precio de la reserva. 'expired': nadie la liquidó
  -- (caída del proceso, fallo de liquidación); la cerró
  -- expire_stale_chat_reservations() por su estimación completa.
  settlement_basis text check (settlement_basis in ('actual', 'estimated', 'reservation_price', 'expired')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (
    (status = 'reserved' and actual_micros is null and settled_at is null and settlement_basis is null)
    or (status = 'settled' and actual_micros is not null and settled_at is not null and settlement_basis is not null)
  )
);

create index if not exists usage_reservations_org_created_at_idx
  on public.usage_reservations (organization_id, created_at);
create index if not exists usage_reservations_org_period_status_idx
  on public.usage_reservations (organization_id, period_start, status);

-- Re-ejecución sobre una tabla creada por una versión anterior de este
-- script (sin 'expired'): `create table if not exists` no cambia un CHECK
-- existente, así que se recrea con su nombre generado por Postgres.
alter table public.usage_reservations drop constraint if exists usage_reservations_settlement_basis_check;
alter table public.usage_reservations add constraint usage_reservations_settlement_basis_check
  check (settlement_basis in ('actual', 'estimated', 'reservation_price', 'expired'));

-- Solo las reservas aún abiertas: búsqueda barata de reservas abandonadas
-- (expire_stale_chat_reservations) aunque la tabla crezca.
create index if not exists usage_reservations_reserved_created_at_idx
  on public.usage_reservations (created_at)
  where status = 'reserved';

-- ── 7. RLS y privilegios de tabla ──────────────────────────────────────────
-- Cero políticas: solo service_role (que omite RLS) lee o escribe. Una
-- futura pantalla de consumo (Fase 5) añadirá una vista/RPC de lectura
-- acotada, después de decidir qué datos ve el cliente.
alter table public.plans enable row level security;
alter table public.organization_quotas enable row level security;
alter table public.model_prices enable row level security;
alter table public.usage_periods enable row level security;
alter table public.usage_conversations enable row level security;
alter table public.usage_reservations enable row level security;

revoke all on table public.plans from anon, authenticated;
revoke all on table public.organization_quotas from anon, authenticated;
revoke all on table public.model_prices from anon, authenticated;
revoke all on table public.usage_periods from anon, authenticated;
revoke all on table public.usage_conversations from anon, authenticated;
revoke all on table public.usage_reservations from anon, authenticated;

grant select, insert, update, delete on table public.plans to service_role;
grant select, insert, update, delete on table public.organization_quotas to service_role;
grant select, insert, update, delete on table public.model_prices to service_role;
grant select, insert, update, delete on table public.usage_periods to service_role;
grant select, insert, update, delete on table public.usage_conversations to service_role;
grant select, insert, update, delete on table public.usage_reservations to service_role;

-- ── 8. quota_cost_micros(): conversión tokens → micro-USD ──────────────────
-- Redondea hacia arriba (conservador). Aritmética numeric, sin floats.
create or replace function public.quota_cost_micros(
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_input_micros_per_mtok bigint,
  p_output_micros_per_mtok bigint
)
returns bigint
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select ceil(
    (p_input_tokens::numeric * p_input_micros_per_mtok
      + p_output_tokens::numeric * p_output_micros_per_mtok) / 1000000
  )::bigint;
$$;

-- ── 9. reserve_chat_usage() ────────────────────────────────────────────────
-- Devuelve jsonb: {allowed, mode, reservation_id, reason, replayed}.
--   mode: 'unconfigured' | 'off' | 'shadow' | 'enforce'
--   reason (denegación en 'enforce', o "habría denegado" en 'shadow'):
--     'suspended' | 'limit_not_configured' | 'hourly_cap_reached'
--     | 'conversation_limit_reached' | 'budget_exhausted' | 'model_price_missing'
--   'unconfigured' (organización sin fila) siempre deniega, con reason
--   'quota_not_configured', sin escribir nada.
-- Lanza excepción (aborta todo) ante argumentos inválidos o un request_id
-- reutilizado para otra organización/sesión.
create or replace function public.reserve_chat_usage(
  p_request_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_model text,
  p_estimated_input_tokens integer,
  p_max_output_tokens integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
-- Por debajo del timeout del backend (3 s, quota-repository.ts): si el
-- bloqueo de la organización no llega a tiempo, la transacción aborta aquí
-- en vez de confirmarse después de que el backend ya se rindió (lo que
-- dejaría una reserva sin ninguna llamada asociada).
set lock_timeout = '2s'
as $$
declare
  v_period date := date_trunc('month', now() at time zone 'utc')::date;
  v_quota public.organization_quotas%rowtype;
  v_plan public.plans%rowtype;
  v_existing public.usage_reservations%rowtype;
  v_price public.model_prices%rowtype;
  v_usage public.usage_periods%rowtype;
  v_conversation_limit integer;
  v_budget bigint;
  v_hourly_cap integer;
  v_is_new_conversation boolean;
  v_recent_count integer;
  v_estimated bigint;
  v_deny text;
  v_reservation_id uuid;
begin
  if p_request_id is null or p_organization_id is null or p_session_id is null
     or p_model is null or length(trim(p_model)) = 0
     or p_estimated_input_tokens is null or p_estimated_input_tokens < 0
     or p_max_output_tokens is null or p_max_output_tokens < 0 then
    raise exception 'QUOTA_INVALID_ARGUMENT';
  end if;

  -- Bloqueo por organización: serializa solo a esta organización.
  select * into v_quota
  from public.organization_quotas
  where organization_id = p_organization_id
  for update;

  -- Idempotencia: un reintento devuelve la reserva original, sin cobrar.
  select * into v_existing
  from public.usage_reservations
  where request_id = p_request_id;

  if found then
    if v_existing.organization_id <> p_organization_id or v_existing.session_id <> p_session_id then
      raise exception 'QUOTA_REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object(
      'allowed', true,
      'mode', v_existing.enforcement_mode,
      'reservation_id', v_existing.id,
      'reason', v_existing.shadow_would_deny,
      'replayed', true
    );
  end if;

  if v_quota.organization_id is null then
    -- Sin fila de cuota: nunca acceso ilimitado. Una organización solo usa
    -- el chat sin límites si tiene una fila EXPLÍCITA en 'off'.
    return jsonb_build_object('allowed', false, 'mode', 'unconfigured', 'reservation_id', null, 'reason', 'quota_not_configured', 'replayed', false);
  end if;

  if v_quota.enforcement_mode = 'off' then
    return jsonb_build_object('allowed', true, 'mode', 'off', 'reservation_id', null, 'reason', null, 'replayed', false);
  end if;

  select * into v_price from public.model_prices where model = p_model;
  if not found then
    -- Sin precio no hay forma de acotar el costo: 'enforce' deniega,
    -- 'shadow' deja pasar sin registrar (nunca un costo inventado).
    return jsonb_build_object(
      'allowed', v_quota.enforcement_mode = 'shadow',
      'mode', v_quota.enforcement_mode,
      'reservation_id', null,
      'reason', 'model_price_missing',
      'replayed', false
    );
  end if;

  if v_quota.plan_code is not null then
    select * into v_plan from public.plans where code = v_quota.plan_code;
  end if;

  v_conversation_limit := coalesce(v_quota.conversation_limit_override, v_plan.monthly_conversation_limit);
  v_budget := coalesce(v_quota.budget_micros_override, v_plan.monthly_budget_micros);
  v_hourly_cap := coalesce(v_quota.hourly_message_cap_override, v_plan.hourly_message_cap);

  v_estimated := public.quota_cost_micros(
    p_estimated_input_tokens, p_max_output_tokens,
    v_price.input_micros_per_mtok, v_price.output_micros_per_mtok
  );

  select * into v_usage
  from public.usage_periods
  where organization_id = p_organization_id and period_start = v_period;

  v_is_new_conversation := not exists (
    select 1 from public.usage_conversations
    where organization_id = p_organization_id and session_id = p_session_id
  );

  select count(*) into v_recent_count
  from public.usage_reservations
  where organization_id = p_organization_id and created_at > now() - interval '1 hour';

  -- Decidir ANTES de escribir nada.
  if v_quota.status = 'suspended' then
    v_deny := 'suspended';
  elsif v_conversation_limit is null or v_budget is null then
    v_deny := 'limit_not_configured';
  elsif v_hourly_cap is not null and v_recent_count >= v_hourly_cap then
    v_deny := 'hourly_cap_reached';
  elsif v_is_new_conversation and coalesce(v_usage.conversations_used, 0) >= v_conversation_limit then
    v_deny := 'conversation_limit_reached';
  elsif coalesce(v_usage.settled_micros, 0) + coalesce(v_usage.reserved_micros, 0) + v_estimated > v_budget then
    v_deny := 'budget_exhausted';
  end if;

  if v_deny is not null and v_quota.enforcement_mode = 'enforce' then
    -- Retorno sin ninguna escritura previa: nada consumido ni contado.
    return jsonb_build_object('allowed', false, 'mode', 'enforce', 'reservation_id', null, 'reason', v_deny, 'replayed', false);
  end if;

  -- A partir de aquí: permitido ('enforce') o modo 'shadow'.
  insert into public.usage_reservations (
    request_id, organization_id, session_id, period_start, enforcement_mode, model,
    estimated_input_tokens, max_output_tokens,
    input_micros_per_mtok, output_micros_per_mtok,
    estimated_micros, shadow_would_deny
  ) values (
    p_request_id, p_organization_id, p_session_id, v_period, v_quota.enforcement_mode, p_model,
    p_estimated_input_tokens, p_max_output_tokens,
    v_price.input_micros_per_mtok, v_price.output_micros_per_mtok,
    v_estimated, case when v_quota.enforcement_mode = 'shadow' then v_deny end
  )
  returning id into v_reservation_id;

  if v_is_new_conversation then
    insert into public.usage_conversations (organization_id, session_id, period_start)
    values (p_organization_id, p_session_id, v_period);
  end if;

  insert into public.usage_periods (
    organization_id, period_start, conversations_used, messages_used, reserved_micros
  ) values (
    p_organization_id, v_period, case when v_is_new_conversation then 1 else 0 end, 1, v_estimated
  )
  on conflict (organization_id, period_start) do update set
    conversations_used = public.usage_periods.conversations_used + excluded.conversations_used,
    messages_used = public.usage_periods.messages_used + 1,
    reserved_micros = public.usage_periods.reserved_micros + excluded.reserved_micros,
    updated_at = now();

  return jsonb_build_object(
    'allowed', true,
    'mode', v_quota.enforcement_mode,
    'reservation_id', v_reservation_id,
    'reason', case when v_quota.enforcement_mode = 'shadow' then v_deny end,
    'replayed', false
  );
end;
$$;

-- ── 10. settle_chat_usage() ────────────────────────────────────────────────
-- p_input_tokens/p_output_tokens NULL (ambos) = uso real desconocido (fallo,
-- aborto) → se conserva la estimación. 0/0 = llamada sin costo. Idempotente:
-- una reserva ya liquidada devuelve su resultado original sin tocar nada.
-- Devuelve jsonb: {reservation_id, actual_micros, basis, replayed}.
create or replace function public.settle_chat_usage(
  p_reservation_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_model text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
-- Mismo motivo que reserve_chat_usage(). Si aborta, el backend reintenta
-- una vez y, si vuelve a fallar, la reserva queda abierta hasta que
-- expire_stale_chat_reservations() la cierre por su estimación.
set lock_timeout = '2s'
as $$
declare
  v_org uuid;
  v_reservation public.usage_reservations%rowtype;
  v_price public.model_prices%rowtype;
  v_model text := nullif(trim(coalesce(p_model, '')), '');
  v_actual bigint;
  v_basis text;
begin
  if p_reservation_id is null
     or (p_input_tokens is null) <> (p_output_tokens is null)
     or p_input_tokens < 0 or p_output_tokens < 0 then
    raise exception 'QUOTA_INVALID_ARGUMENT';
  end if;

  select organization_id into v_org from public.usage_reservations where id = p_reservation_id;
  if not found then
    raise exception 'QUOTA_RESERVATION_NOT_FOUND';
  end if;

  -- Mismo orden de bloqueo que reserve_chat_usage(): organización primero.
  perform 1 from public.organization_quotas where organization_id = v_org for update;

  select * into v_reservation from public.usage_reservations where id = p_reservation_id for update;

  if v_reservation.status = 'settled' then
    return jsonb_build_object(
      'reservation_id', v_reservation.id,
      'actual_micros', v_reservation.actual_micros,
      'basis', v_reservation.settlement_basis,
      'replayed', true
    );
  end if;

  if p_input_tokens is null then
    v_actual := v_reservation.estimated_micros;
    v_basis := 'estimated';
  elsif v_model is null or v_model = v_reservation.model then
    v_actual := public.quota_cost_micros(
      p_input_tokens, p_output_tokens,
      v_reservation.input_micros_per_mtok, v_reservation.output_micros_per_mtok
    );
    v_basis := 'actual';
  else
    select * into v_price from public.model_prices where model = v_model;
    if found then
      v_actual := public.quota_cost_micros(
        p_input_tokens, p_output_tokens,
        v_price.input_micros_per_mtok, v_price.output_micros_per_mtok
      );
      v_basis := 'actual';
    else
      v_actual := greatest(
        v_reservation.estimated_micros,
        public.quota_cost_micros(
          p_input_tokens, p_output_tokens,
          v_reservation.input_micros_per_mtok, v_reservation.output_micros_per_mtok
        )
      );
      v_basis := 'reservation_price';
    end if;
  end if;

  update public.usage_reservations set
    status = 'settled',
    actual_input_tokens = p_input_tokens,
    actual_output_tokens = p_output_tokens,
    actual_model = v_model,
    actual_micros = v_actual,
    settlement_basis = v_basis,
    settled_at = now()
  where id = v_reservation.id;

  -- Siempre al periodo de la RESERVA, aunque hoy sea otro mes.
  update public.usage_periods set
    reserved_micros = reserved_micros - v_reservation.estimated_micros,
    settled_micros = settled_micros + v_actual,
    updated_at = now()
  where organization_id = v_reservation.organization_id
    and period_start = v_reservation.period_start;

  if not found then
    raise exception 'QUOTA_PERIOD_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'reservation_id', v_reservation.id,
    'actual_micros', v_actual,
    'basis', v_basis,
    'replayed', false
  );
end;
$$;

-- ── 11. get_organization_quota_status(): solo lectura ──────────────────────
-- Para la comprobación previa al crear una sesión (Fase 4). No bloquea ni
-- escribe; la decisión autoritativa es siempre reserve_chat_usage().
--
-- p_model (opcional): si se pasa, la respuesta incluye
-- 'model_price_configured' (true/false) — si model_prices tiene una fila
-- para ESE identificador exacto. Permite no abrir en 'enforce' una
-- conversación cuyo primer mensaje reserve_chat_usage() denegaría con
-- 'model_price_missing'. Sin p_model, la respuesta es la de siempre.
--
-- La versión anterior tenía la firma (uuid). Una sobrecarga (uuid, text
-- default null) junto a ella haría AMBIGUA toda llamada con un solo
-- argumento ("function is not unique"), también vía PostgREST, así que la
-- anterior se elimina antes de crear esta.
drop function if exists public.get_organization_quota_status(uuid);

create or replace function public.get_organization_quota_status(
  p_organization_id uuid,
  p_model text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_period date := date_trunc('month', now() at time zone 'utc')::date;
  v_quota public.organization_quotas%rowtype;
  v_plan public.plans%rowtype;
  v_usage public.usage_periods%rowtype;
  v_price jsonb := '{}'::jsonb;
begin
  if p_organization_id is null then
    raise exception 'QUOTA_INVALID_ARGUMENT';
  end if;

  if p_model is not null then
    v_price := jsonb_build_object(
      'model_price_configured',
      exists (select 1 from public.model_prices where model = p_model)
    );
  end if;

  select * into v_quota from public.organization_quotas where organization_id = p_organization_id;
  if not found then
    return jsonb_build_object('mode', 'unconfigured', 'period_start', v_period) || v_price;
  end if;

  if v_quota.plan_code is not null then
    select * into v_plan from public.plans where code = v_quota.plan_code;
  end if;

  select * into v_usage
  from public.usage_periods
  where organization_id = p_organization_id and period_start = v_period;

  return jsonb_build_object(
    'mode', v_quota.enforcement_mode,
    'status', v_quota.status,
    'plan_code', v_quota.plan_code,
    'period_start', v_period,
    'conversation_limit', coalesce(v_quota.conversation_limit_override, v_plan.monthly_conversation_limit),
    'budget_micros', coalesce(v_quota.budget_micros_override, v_plan.monthly_budget_micros),
    'hourly_message_cap', coalesce(v_quota.hourly_message_cap_override, v_plan.hourly_message_cap),
    'conversations_used', coalesce(v_usage.conversations_used, 0),
    'messages_used', coalesce(v_usage.messages_used, 0),
    'reserved_micros', coalesce(v_usage.reserved_micros, 0),
    'settled_micros', coalesce(v_usage.settled_micros, 0)
  ) || v_price;
end;
$$;

-- ── 12. Privilegios de ejecución: solo service_role ───────────────────────
-- Postgres otorga EXECUTE a PUBLIC al crear una función, y Supabase además
-- lo otorga explícitamente a anon/authenticated por default privileges —
-- por eso se revoca de los tres, igual que claim_webhook_deliveries().
revoke all on function public.quota_cost_micros(bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.reserve_chat_usage(uuid, uuid, uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.settle_chat_usage(uuid, integer, integer, text) from public, anon, authenticated;
revoke all on function public.get_organization_quota_status(uuid, text) from public, anon, authenticated;

grant execute on function public.quota_cost_micros(bigint, bigint, bigint, bigint) to service_role;
grant execute on function public.reserve_chat_usage(uuid, uuid, uuid, text, integer, integer) to service_role;
grant execute on function public.settle_chat_usage(uuid, integer, integer, text) to service_role;
grant execute on function public.get_organization_quota_status(uuid, text) to service_role;

-- ── 13. Cuota automática para organizaciones nuevas ───────────────────────
-- Toda organización insertada después de esta migración recibe su fila en
-- organization_quotas en modo 'shadow' (plan 'pilot'), para que ninguna
-- quede sin fila (= 'unconfigured', que reserve_chat_usage() deniega).
--
-- SECURITY DEFINER es necesario: quien inserta en organizations suele ser
-- el propio usuario (rol authenticated, alta automática de
-- OrganizationProvider.tsx), que no tiene ningún privilegio sobre
-- organization_quotas (sección 7). La función corre como su dueño (el rol
-- que ejecuta este script), que sí lo tiene. Es segura porque el usuario no
-- controla nada de lo que escribe: solo NEW.id (la organización que acaba
-- de crear); plan y modo están fijados aquí, y ON CONFLICT DO NOTHING
-- impide sobrescribir una fila existente (p. ej. una en 'enforce' u 'off').
-- El plan se busca en vez de escribirse literal: si 'pilot' no existiera,
-- queda NULL en lugar de romper la FK.
--
-- BEGIN...EXCEPTION WHEN OTHERS, igual que notify_lead_created(): un fallo
-- aquí no debe impedir crear la organización (eso rompería el registro de
-- usuarios). Es seguro tragarlo porque una organización sin fila queda
-- DENEGADA, no ilimitada; RAISE WARNING lo deja en el log de Postgres.
create or replace function public.create_default_organization_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into public.organization_quotas (organization_id, plan_code, enforcement_mode)
    values (NEW.id, (select code from public.plans where code = 'pilot'), 'shadow')
    on conflict (organization_id) do nothing;
  exception
    when others then
      raise warning 'create_default_organization_quota: no se pudo crear la cuota de la organización %: % (SQLSTATE %)',
        NEW.id, SQLERRM, SQLSTATE;
  end;
  return NEW;
end;
$$;

-- Higiene (como notify_lead_created): disparar un trigger no requiere
-- EXECUTE, y Postgres no permite llamar directamente a una función
-- `returns trigger`.
revoke all on function public.create_default_organization_quota() from public, anon, authenticated;

drop trigger if exists organizations_create_default_quota on public.organizations;
create trigger organizations_create_default_quota
  after insert on public.organizations
  for each row
  execute function public.create_default_organization_quota();

-- ── 14. expire_stale_chat_reservations(): reservas abandonadas ─────────────
-- Cierra las reservas que siguen en 'reserved' más de p_older_than (mínimo y
-- valor por defecto: 15 minutos) — el proceso murió entre la reserva y la
-- liquidación (reinicio/SIGKILL de Railway) o la liquidación falló dos
-- veces. Ver DISENO_RIESGO_2.txt para el razonamiento completo.
--
-- * NUNCA gratis: se cierran por su estimated_micros COMPLETO (cota
--   superior), con settlement_basis = 'expired'. Una llamada que pudo
--   facturarse nunca se libera. Mover reserved → settled por el mismo
--   importe no cambia el presupuesto disponible.
-- * ABANDONADA vs ACTIVA: solo el reloj de Postgres (created_at y now()).
--   Una reserva activa vive como mucho ~70 s con los timeouts actuales del
--   backend (REQUEST_TIMEOUT_MS = 45 s en routes/chat.ts + timeouts de las
--   RPC y de usage_events); 15 min deja un margen de más de 10×. El mínimo
--   de 15 min está forzado aquí: ningún llamador puede pedir menos.
-- * ATÓMICA por organización: subtransacción (BEGIN…EXCEPTION) bajo el
--   bloqueo de su fila de organization_quotas — las reservas y los
--   contadores de sus periodos cambian juntos o no cambian. Un fallo en una
--   organización revierte solo esa organización y se reporta.
-- * CONCURRENCIA: mismo orden de bloqueo que reserve/settle (organización
--   primero) y SKIP LOCKED: una organización atendiendo un mensaje ahora
--   mismo se salta y se procesa en la pasada siguiente; esta función nunca
--   hace esperar al tráfico real. Organizaciones en orden fijo: sin
--   deadlocks entre varias ejecuciones simultáneas.
-- * IDEMPOTENTE: el UPDATE vuelve a exigir status = 'reserved' tras obtener
--   el bloqueo de fila, así que una liquidación que gane la carrera no se
--   cuenta dos veces, y una segunda ejecución no cambia nada. Una
--   liquidación que llegue DESPUÉS recibe la reserva ya cerrada (replay).
-- * CAMBIO DE MES: cada reserva se aplica a SU period_start, igual que
--   settle_chat_usage().
-- * ACOTADA: p_max_organizations por llamada; el resto, en la siguiente.
--
-- Devuelve jsonb: {expired_count, expired_micros, organizations_processed,
-- organizations_skipped_locked, organizations_failed}.
create or replace function public.expire_stale_chat_reservations(
  p_older_than interval default interval '15 minutes',
  p_max_organizations integer default 100
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set lock_timeout = '2s'
as $$
declare
  v_org uuid;
  v_count integer;
  v_micros bigint;
  v_missing_periods integer;
  v_expired_count integer := 0;
  v_expired_micros bigint := 0;
  v_processed integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
begin
  if p_older_than is null or p_older_than < interval '15 minutes'
     or p_max_organizations is null or p_max_organizations < 1 or p_max_organizations > 1000 then
    raise exception 'QUOTA_INVALID_ARGUMENT';
  end if;

  for v_org in
    select r.organization_id
    from public.usage_reservations r
    where r.status = 'reserved' and r.created_at < now() - p_older_than
    group by r.organization_id
    order by r.organization_id
    limit p_max_organizations
  loop
    begin
      -- Organización primero. Sin fila de cuota (borrada a mano) no hay
      -- nada que bloquear: settle_chat_usage() tampoco bloquea en ese caso.
      if exists (select 1 from public.organization_quotas where organization_id = v_org) then
        perform 1 from public.organization_quotas
        where organization_id = v_org
        for update skip locked;
        if not found then
          v_skipped := v_skipped + 1;
          continue;
        end if;
      end if;

      with expired as (
        update public.usage_reservations r set
          status = 'settled',
          actual_micros = r.estimated_micros,
          settlement_basis = 'expired',
          settled_at = now()
        where r.organization_id = v_org
          and r.status = 'reserved'
          and r.created_at < now() - p_older_than
        returning r.period_start, r.estimated_micros
      ), per_period as (
        select period_start, sum(estimated_micros)::bigint as micros, count(*)::integer as n
        from expired
        group by period_start
      ), updated as (
        update public.usage_periods p set
          reserved_micros = p.reserved_micros - pp.micros,
          settled_micros = p.settled_micros + pp.micros,
          updated_at = now()
        from per_period pp
        where p.organization_id = v_org and p.period_start = pp.period_start
        returning p.period_start
      )
      select
        (select coalesce(sum(n), 0) from per_period),
        (select coalesce(sum(micros), 0) from per_period),
        (select count(*) from per_period) - (select count(*) from updated)
      into v_count, v_micros, v_missing_periods;

      -- Un periodo inexistente rompería el invariante reserved_micros =
      -- suma de reservas abiertas: se revierte esta organización entera.
      -- (Un reserved_micros negativo lo impide ya su CHECK >= 0.)
      if v_missing_periods > 0 then
        raise exception 'QUOTA_PERIOD_NOT_FOUND';
      end if;

      v_expired_count := v_expired_count + v_count;
      v_expired_micros := v_expired_micros + v_micros;
      v_processed := v_processed + 1;
    exception
      when others then
        v_failed := v_failed + 1;
        raise warning 'expire_stale_chat_reservations: organización % no conciliada: % (SQLSTATE %)',
          v_org, SQLERRM, SQLSTATE;
    end;
  end loop;

  return jsonb_build_object(
    'expired_count', v_expired_count,
    'expired_micros', v_expired_micros,
    'organizations_processed', v_processed,
    'organizations_skipped_locked', v_skipped,
    'organizations_failed', v_failed
  );
end;
$$;

revoke all on function public.expire_stale_chat_reservations(interval, integer) from public, anon, authenticated;
grant execute on function public.expire_stale_chat_reservations(interval, integer) to service_role;

-- ── verificación (solo lectura; ejecutar después de aplicar) ───────────────
-- 1) Tablas y columnas.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('plans', 'organization_quotas', 'model_prices', 'usage_periods', 'usage_conversations', 'usage_reservations')
order by table_name, ordinal_position;

-- 2) RLS activado en las seis tablas (relrowsecurity = true) y CERO
--    políticas (la segunda consulta debe devolver cero filas).
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('plans', 'organization_quotas', 'model_prices', 'usage_periods', 'usage_conversations', 'usage_reservations');

select tablename, policyname
from pg_policies
where tablename in ('plans', 'organization_quotas', 'model_prices', 'usage_periods', 'usage_conversations', 'usage_reservations');

-- 3) anon/authenticated sin ningún privilegio de tabla (todo debe ser false).
select r.role, t.tbl,
       has_table_privilege(r.role, t.tbl, 'select') as can_select,
       has_table_privilege(r.role, t.tbl, 'insert') as can_insert,
       has_table_privilege(r.role, t.tbl, 'update') as can_update,
       has_table_privilege(r.role, t.tbl, 'delete') as can_delete,
       has_table_privilege(r.role, t.tbl, 'truncate') as can_truncate
from (values ('anon'), ('authenticated')) as r(role)
cross join (values
  ('public.plans'), ('public.organization_quotas'), ('public.model_prices'),
  ('public.usage_periods'), ('public.usage_conversations'), ('public.usage_reservations')
) as t(tbl)
order by 1, 2;

-- 4) EXECUTE: anon/authenticated = false, service_role = true.
select r.role, f.fn, has_function_privilege(r.role, f.fn, 'execute') as can_execute
from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
cross join (values
  ('public.quota_cost_micros(bigint, bigint, bigint, bigint)'),
  ('public.reserve_chat_usage(uuid, uuid, uuid, text, integer, integer)'),
  ('public.settle_chat_usage(uuid, integer, integer, text)'),
  ('public.get_organization_quota_status(uuid, text)')
) as f(fn)
order by 2, 1;

-- 5) Las cuatro funciones son SECURITY INVOKER (prosecdef = false) con
--    search_path fijado (proconfig).
select proname, prosecdef, proconfig
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('quota_cost_micros', 'reserve_chat_usage', 'settle_chat_usage', 'get_organization_quota_status');

-- 6) Compatibilidad (justo después de la PRIMERA aplicación): cada
--    organización tiene fila y TODAS están en 'off'. Deben coincidir
--    total_orgs = with_quota = mode_off, y not_off = 0. Las organizaciones
--    creadas después aparecen en 'shadow' (trigger de la sección 13).
select
  (select count(*) from public.organizations) as total_orgs,
  (select count(*) from public.organization_quotas) as with_quota,
  (select count(*) from public.organization_quotas where enforcement_mode = 'off') as mode_off,
  (select count(*) from public.organization_quotas where enforcement_mode <> 'off') as not_off;

-- 7) Ningún plan activo ni con límites, ningún precio cargado.
select code, is_active, monthly_conversation_limit, monthly_budget_micros, hourly_message_cap from public.plans order by code;
select count(*) as model_prices_rows from public.model_prices;

-- 8) Trigger de cuota automática: existe, está habilitado ('O') y su función
--    es SECURITY DEFINER con search_path fijado; nadie salvo su dueño puede
--    ejecutarla directamente (las tres columnas can_execute = false).
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.organizations'::regclass and tgname = 'organizations_create_default_quota';

select proname, prosecdef, proconfig,
       has_function_privilege('anon', oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', oid, 'execute') as authenticated_can_execute,
       has_function_privilege('public', oid, 'execute') as public_can_execute
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'create_default_organization_quota';

-- 9) Conciliación de reservas abandonadas: la función es SECURITY INVOKER
--    con search_path y lock_timeout fijados; solo service_role puede
--    ejecutarla; el CHECK de settlement_basis acepta 'expired'.
select proname, prosecdef, proconfig,
       has_function_privilege('anon', oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', oid, 'execute') as authenticated_can_execute,
       has_function_privilege('service_role', oid, 'execute') as service_role_can_execute
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'expire_stale_chat_reservations';

select pg_get_constraintdef(oid) as settlement_basis_check
from pg_constraint
where conrelid = 'public.usage_reservations'::regclass and conname = 'usage_reservations_settlement_basis_check';

-- 10) Monitorización (solo lectura, ejecutable en cualquier momento):
--     a) Reservas abiertas con más de 15 min (≈ 0 tras cada pasada).
select organization_id, count(*) as stale_reserved, min(created_at) as oldest
from public.usage_reservations
where status = 'reserved' and created_at < now() - interval '15 minutes'
group by organization_id;

--     b) Reservas cerradas por expiración, por día y organización (cada una
--        indica una caída del proceso o un fallo de liquidación).
select organization_id, settled_at::date as day, count(*) as expired, sum(actual_micros) as micros
from public.usage_reservations
where settlement_basis = 'expired'
group by 1, 2
order by 2 desc, 1;

--     c) Invariante: reserved_micros de cada periodo = suma de estimated_micros
--        de sus reservas abiertas (debe devolver CERO filas).
select p.organization_id, p.period_start, p.reserved_micros, coalesce(r.open_micros, 0) as open_micros
from public.usage_periods p
left join (
  select organization_id, period_start, sum(estimated_micros) as open_micros
  from public.usage_reservations
  where status = 'reserved'
  group by organization_id, period_start
) r on r.organization_id = p.organization_id and r.period_start = p.period_start
where p.reserved_micros <> coalesce(r.open_micros, 0);

-- 11) Precios: las cinco restricciones de sanidad de model_prices existen, y
--     get_organization_quota_status solo tiene la firma nueva (uuid, text).
--     Las consultas de vigilancia de precios y modelos (que leen también
--     usage_events) están en supabase/monitoring-usage-quotas.sql, aparte,
--     para que esta migración siga dependiendo solo de `organizations`.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.model_prices'::regclass and conname like 'model_prices_%_check'
order by conname;

select oid::regprocedure as signature
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'get_organization_quota_status';

-- ── reversión (NO ejecutar salvo que se quiera deshacer esta migración) ────
-- Elimina únicamente lo creado aquí. Ningún otro objeto depende de estas
-- tablas/funciones mientras la Fase 2 no esté desplegada. Se pierde el
-- historial de reservas/consumo acumulado en ellas (usage_events no se toca).
--
-- drop function if exists public.expire_stale_chat_reservations(interval, integer);
-- drop trigger if exists organizations_create_default_quota on public.organizations;
-- drop function if exists public.create_default_organization_quota();
-- drop function if exists public.get_organization_quota_status(uuid, text);
-- drop function if exists public.settle_chat_usage(uuid, integer, integer, text);
-- drop function if exists public.reserve_chat_usage(uuid, uuid, uuid, text, integer, integer);
-- drop function if exists public.quota_cost_micros(bigint, bigint, bigint, bigint);
-- drop table if exists public.usage_reservations;
-- drop table if exists public.usage_conversations;
-- drop table if exists public.usage_periods;
-- drop table if exists public.model_prices;
-- drop table if exists public.organization_quotas;
-- drop table if exists public.plans;
