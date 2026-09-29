-- Lead AI — Fase B: usage_events (medición de consumo real de Anthropic).
--
-- Alcance de esta migración: ÚNICAMENTE la tabla usage_events y su RLS.
-- Puramente aditiva — no toca ninguna tabla, política, trigger ni función
-- existente. NO ejecutada contra Supabase — preparada para revisión y
-- aplicación manual, igual que el resto de migraciones de este proyecto.
--
-- Ejecutar una sola vez, sobre un proyecto que ya corrió schema.sql (o
-- schema.sql + migrations-phase8.sql) — depende únicamente de
-- `organizations` y de is_org_member(), ambas ya existentes desde esas
-- migraciones.
--
-- Propósito: registrar, evento a evento (nunca agregados pre-calculados),
-- el consumo REAL que Anthropic devuelve tras cada llamada del chat de
-- Lead AI — nunca una estimación. Ver server/src/services/ai-provider.ts
-- y chat-service.ts para dónde se captura ese `usage` real del SDK y
-- server/src/repositories/usage-events-repository.ts para quién escribe
-- esta tabla (únicamente el backend Express, vía service_role).

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- El id de sesión de chat tal como lo genera el backend Express
  -- (randomUUID() — ver server/src/repositories/session-repository.ts),
  -- el mismo valor que create_public_chat_session()/chat_sessions.id usan
  -- cuando el backend de datos activo es 'supabase'. Se usa el tipo uuid
  -- porque el valor SIEMPRE es un uuid real generado por randomUUID() —
  -- no es una decisión arbitraria. Deliberadamente SIN foreign key hacia
  -- chat_sessions(id): chat_sessions es un espejo de visualización que el
  -- FRONTEND escribe solo cuando VITE_DATA_BACKEND='supabase' (ver
  -- CLAUDE.md, "Chat sessions in Postgres") — en modo 'local' esa fila
  -- nunca existe, aunque la sesión sí exista de verdad en
  -- server/data/sessions.json y sí deba poder medirse. Forzar esa FK
  -- rompería el registro de uso en cualquier despliegue en modo 'local'.
  session_id uuid not null,
  purpose text not null check (purpose in ('reply', 'extraction')),
  -- El modelo REAL informado por la propia respuesta de Anthropic para
  -- esa llamada (Message.model del SDK) — nunca config.anthropicModel ni
  -- ninguna otra etiqueta local. Ver ai-provider.ts.
  model text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  created_at timestamptz not null default now()
);

-- Patrón de acceso principal: "el consumo de esta organización en este
-- rango de fechas" — ver el informe de la Fase B para las consultas
-- exactas de conversaciones/mensajes/llamadas/tokens que este índice sirve.
create index if not exists usage_events_organization_id_created_at_idx
  on usage_events (organization_id, created_at);
create index if not exists usage_events_session_id_idx
  on usage_events (session_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
alter table usage_events enable row level security;
drop policy if exists "usage_events_select" on usage_events;

-- SELECT: cualquier miembro de la organización (owner/admin/member/viewer
-- por igual — esta fase no introduce ninguna pantalla ni diferenciación de
-- rol todavía, solo la base de datos para poder leerlo más adelante).
create policy "usage_events_select" on usage_events for select
  using (is_org_member(organization_id));

-- Deliberadamente SIN política de insert/update/delete para
-- anon/authenticated — mismo patrón ya usado en webhook_deliveries y
-- hubspot_contact_links. El ÚNICO escritor es el backend Express vía la
-- clave service_role ya existente (server/src/lib/supabase-client.ts —
-- la misma credencial que ya usan Webhooks y HubSpot; esta fase no añade
-- ningún secreto nuevo). Con cero política de escritura, un intento
-- directo de insert/update/delete desde el navegador, con cualquier rol
-- autenticado o anónimo, es rechazado por RLS, punto.

-- ── verificación ────────────────────────────────────────────────────────
-- 1) Confirmar que la tabla y sus columnas existen.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'usage_events'
order by ordinal_position;

-- 2) Confirmar que las políticas RLS coinciden con el diseño de arriba —
--    debe aparecer EXACTAMENTE una fila (la de SELECT).
select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename = 'usage_events';

-- 3) Confirmar los checks/constraints (purpose, tokens no negativos).
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'usage_events'::regclass and contype = 'c';

-- 4) Prueba manual (una vez que el backend empiece a escribir de verdad):
--    - Como 'member'/'viewer' autenticado de la Organización A, `select *
--      from usage_events where organization_id = '<uuid de Organización B>'`
--      — debe devolver cero filas, sin error de autorización (la política
--      simplemente no matchea ninguna fila).
--    - Cualquier intento directo de `insert into usage_events (...)` desde
--      un cliente autenticado o anónimo (nunca desde el backend) debe
--      fallar por violación de política RLS.
