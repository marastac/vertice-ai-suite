-- MAASTAC AI (técnicamente "Lead AI") — Copia durable de las sesiones de chat
-- del BACKEND en Postgres (persistencia de conversaciones, Fase 3).
--
-- Hoy la conversación que se envía a Claude vive solo en
-- server/data/sessions.json. En Railway sin volumen ese archivo se pierde en
-- cada redeploy: las conversaciones en curso dejan de funcionar ("Esta
-- conversación ya no está disponible").
--
-- Esta tabla guarda una INSTANTÁNEA completa de cada sesión (historial,
-- configuración, organización, calificación) escrita por el backend con la
-- clave de servicio. Solo se usa con CHAT_SESSION_STORE=postgres (apagado por
-- defecto, ver server/src/services/durable-session-sync.ts). sessions.json
-- sigue siendo la fuente principal; al arrancar, el backend recupera de aquí
-- las sesiones recientes que falten en disco.
--
-- Seguridad:
--   * Contiene datos personales (transcripciones): RLS activado, CERO
--     políticas y REVOKE ALL a anon/authenticated. Solo service_role.
--   * Una sesión nunca cambia de organización: puede pasar de NULL (aún sin
--     resolver) a una organización, pero no de una organización a otra.
--   * Escrituras fuera de orden nunca hacen retroceder el estado: solo se
--     aplica una versión estrictamente mayor que la guardada.
--   * Al borrar una organización se borran sus sesiones (on delete cascade).
--
-- NO cubre (deliberadamente): retención/purga (pendiente de decisión legal)
-- ni migración de sessions.json existentes (no se migra ni borra nada).
--
-- Re-ejecutable. NO ejecutada contra ninguna base real. schema.sql contiene
-- lo mismo para proyectos nuevos. Pruebas: supabase/tests-backend-chat-sessions.sql
-- y `npm run test:db:concurrency` (S1), en un Postgres desechable.

create table if not exists public.backend_chat_sessions (
  id uuid primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  org_slug text not null check (length(org_slug) between 1 and 100),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  version bigint not null check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backend_chat_sessions_updated_at_idx
  on public.backend_chat_sessions (updated_at desc);
create index if not exists backend_chat_sessions_organization_id_idx
  on public.backend_chat_sessions (organization_id);

alter table public.backend_chat_sessions enable row level security;
revoke all on table public.backend_chat_sessions from anon, authenticated;

-- Guarda una instantánea. Devuelve true si se aplicó; false si había una
-- versión igual o más nueva, o si la sesión pertenece a OTRA organización.
create or replace function public.save_backend_chat_session(
  p_id uuid,
  p_organization_id uuid,
  p_org_slug text,
  p_state jsonb,
  p_version bigint
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_applied boolean;
begin
  if p_id is null or p_org_slug is null or p_state is null or p_version is null or p_version <= 0 then
    raise exception 'BACKEND_SESSION_INVALID_ARGUMENT';
  end if;

  insert into public.backend_chat_sessions as s (id, organization_id, org_slug, state, version)
  values (p_id, p_organization_id, p_org_slug, p_state, p_version)
  on conflict (id) do update set
    organization_id = coalesce(s.organization_id, excluded.organization_id),
    org_slug = excluded.org_slug,
    state = excluded.state,
    version = excluded.version,
    updated_at = now()
  where s.version < excluded.version
    and (s.organization_id is null or excluded.organization_id is null or s.organization_id = excluded.organization_id)
  returning true into v_applied;

  return coalesce(v_applied, false);
end;
$$;

-- Sesiones actualizadas desde p_since (las más recientes primero), para la
-- recuperación al arrancar.
create or replace function public.list_recent_backend_chat_sessions(
  p_since timestamptz,
  p_limit integer default 5000
)
returns table (id uuid, organization_id uuid, org_slug text, state jsonb, version bigint, updated_at timestamptz)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select s.id, s.organization_id, s.org_slug, s.state, s.version, s.updated_at
  from public.backend_chat_sessions s
  where s.updated_at >= p_since
  order by s.updated_at desc
  limit least(greatest(coalesce(p_limit, 5000), 1), 20000)
$$;

revoke all on function public.save_backend_chat_session(uuid, uuid, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.save_backend_chat_session(uuid, uuid, text, jsonb, bigint) to service_role;
revoke all on function public.list_recent_backend_chat_sessions(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.list_recent_backend_chat_sessions(timestamptz, integer) to service_role;
grant select, insert, update on table public.backend_chat_sessions to service_role;

-- ── verificación (solo lectura) ────────────────────────────────────────────
select relname, relrowsecurity,
       has_table_privilege('anon', oid, 'select') as anon_select,
       has_table_privilege('authenticated', oid, 'select') as authenticated_select
from pg_class where oid = 'public.backend_chat_sessions'::regclass;

-- ── reversión (NO ejecutar salvo que se quiera deshacer) ───────────────────
-- Antes, CHAT_SESSION_STORE debe estar apagado en el backend. Borra las
-- copias durables (sessions.json no se ve afectado).
-- drop function if exists public.list_recent_backend_chat_sessions(timestamptz, integer);
-- drop function if exists public.save_backend_chat_session(uuid, uuid, text, jsonb, bigint);
-- drop table if exists public.backend_chat_sessions;
