-- Lead AI — HubSpot CRM integration, Fase 1: base de datos + RLS.
--
-- Alcance de esta migración: ÚNICAMENTE hubspot_connections +
-- hubspot_contact_links, sus políticas RLS, y una restricción aditiva sobre
-- la tabla `leads` ya existente (necesaria para la integridad multi-tenant
-- de hubspot_contact_links — ver el bloque 0 abajo). Sin flujo OAuth, sin
-- llamadas a la API de HubSpot, sin lógica de sincronización — todo eso son
-- fases posteriores. NO ejecutada contra Supabase — preparada para revisión
-- y aplicación manual, igual que el resto de migraciones de este proyecto.
--
-- Ejecutar una sola vez, sobre un proyecto que ya corrió
-- schema.sql/migrations-phase8.sql (organizations, organization_members,
-- is_org_member(), is_org_admin(), y la tabla `leads` ya existen).
--
-- Este script no toca ninguna tabla, política, trigger ni función de
-- Webhooks. La única modificación a una tabla preexistente es aditiva
-- (bloque 0, sobre `leads`) y no altera ni elimina nada de lo ya definido
-- ahí.

-- ── 0. Prerrequisito de integridad multi-tenant sobre `leads` ──────────────
-- hubspot_contact_links (bloque 3) necesita garantizar, a nivel de
-- restricción de base de datos, que su par (organization_id, lead_id)
-- siempre corresponde a un lead que REALMENTE pertenece a esa organización
-- — no solo que lead_id referencia *algún* lead existente. Una FK simple a
-- leads(id) no lo garantiza: nada impediría insertar una fila que combine
-- el organization_id de la Organización A con un lead_id que en realidad
-- pertenece a la Organización B.
--
-- La solución es una FK compuesta (bloque 3), que exige que las columnas
-- referenciadas en `leads` estén respaldadas por una restricción única.
-- `leads.id` ya es único por ser la primary key, así que esta restricción
-- adicional sobre (id, organization_id) es trivialmente satisfacible — no
-- rechaza ninguna fila existente, solo hace que el par sea referenciable de
-- forma compuesta. Puramente aditiva: no reemplaza ni elimina la primary
-- key ni ninguna otra restricción/FK ya definida sobre `leads` (incluida la
-- que usa webhook_deliveries.lead_id, que sigue intacta).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_id_organization_id_key' and conrelid = 'leads'::regclass
  ) then
    alter table leads
      add constraint leads_id_organization_id_key unique (id, organization_id);
  end if;
end $$;

-- ── 1. hubspot_connections ──────────────────────────────────────────────
-- Una fila por organización (organization_id UNIQUE) — un solo portal de
-- HubSpot por organización en este MVP, mismo patrón "una fila por
-- organización" que webhook_configurations.
create table if not exists hubspot_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  -- El id de cuenta/portal de HubSpot conectado. NOT NULL es deliberado:
  -- el callback de OAuth (fase posterior) debe obtener el portal id desde
  -- HubSpot (vía la llamada de introspección del token) ANTES de insertar
  -- esta fila — la respuesta del intercambio de tokens en sí no lo
  -- incluye. Una conexión sin portal id conocido no es una conexión
  -- completa y mostrable ("Conectado al portal X" no tendría qué mostrar),
  -- así que no debería persistirse en absoluto en vez de persistirse con
  -- un valor nulo/placeholder y corregirse después — mismo principio ya
  -- usado en el onboarding de organizaciones (completeOrganizationOnboarding()
  -- marca completado solo al final, nunca antes de que todo lo necesario
  -- exista). Si la obtención del portal id falla, todo el callback falla y
  -- el admin simplemente reintenta "Conectar" — nunca se escribe una fila
  -- parcial.
  hub_portal_id text not null,
  -- Ciphertext AES-256-GCM en formato base64 versionado, producido por
  -- server/src/lib/hubspot-crypto.ts (ver ese archivo). Nunca texto plano.
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  access_token_expires_at timestamptz not null,
  -- Lista de scopes efectivamente otorgados, separados por espacio — le
  -- permite a una futura verificación de "scope insuficiente" comparar lo
  -- que tenemos contra lo que ahora necesitamos, sin otra llamada a
  -- HubSpot.
  scopes text not null,
  -- true cuando un intento de refresh falla de forma definitiva (refresh
  -- token revocado/inválido) — la fila se conserva (no se borra) para que
  -- la UI pueda mostrar "Reconecta tu cuenta de HubSpot" en vez de volver
  -- silenciosamente a "No conectado" sin explicación.
  needs_reauth boolean not null default false,
  -- Siempre NULL hasta que una fase posterior lo conecte con auth.uid() en
  -- el insert — misma convención que cualquier otra columna created_by/
  -- connected_by de este proyecto (ver webhook_configurations.created_by).
  -- Deliberadamente NO es una foreign key a auth.users(id) — mismo motivo
  -- de fricción de permisos/grants ya documentado para el resto de esas
  -- columnas en schema.sql.
  connected_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── 2. RLS: hubspot_connections ──────────────────────────────────────────
alter table hubspot_connections enable row level security;
drop policy if exists "hubspot_connections_insert_admins" on hubspot_connections;
drop policy if exists "hubspot_connections_update_admins" on hubspot_connections;
drop policy if exists "hubspot_connections_delete_admins" on hubspot_connections;

-- Deliberadamente SIN política SELECT para anon/authenticated — mismo
-- razonamiento que la columna `secret` de webhook_configurations (ver
-- migrations-webhooks.sql). Con cero política SELECT, una llamada REST
-- directa de cualquier usuario autenticado, con cualquier rol, en
-- cualquier organización, devuelve cero filas, punto. El ÚNICO lector es
-- el backend Express vía la clave service_role (que evita RLS por
-- diseño), y ese backend elimina access_token_encrypted/
-- refresh_token_encrypted antes de construir cualquier respuesta JSON —
-- ver server/src/repositories/hubspot-repository.ts's toPublicConnection().
-- La vista de solo-lectura del estado de conexión para member/viewer (fase
-- posterior) se sirve mediante un endpoint del backend por este mismo
-- motivo, nunca mediante una lectura directa a Supabase.
--
-- INSERT/UPDATE/DELETE: solo owner/admin. En la práctica siempre
-- ejecutado por el backend usando service_role (que evita RLS) — estas
-- políticas existen como defensa en profundidad, misma convención ya
-- documentada para cualquier otra tabla admin-gated de este proyecto.
-- WITH CHECK espeja USING en UPDATE para que un admin no pueda mover una
-- fila a otro organization_id en la misma sentencia.
create policy "hubspot_connections_insert_admins" on hubspot_connections for insert
  with check (is_org_admin(organization_id));
create policy "hubspot_connections_update_admins" on hubspot_connections for update
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));
create policy "hubspot_connections_delete_admins" on hubspot_connections for delete
  using (is_org_admin(organization_id));

-- ── 3. hubspot_contact_links ─────────────────────────────────────────────
-- Mapeo de "estado actual" entre un lead de Lead AI y su contacto en
-- HubSpot — una fila por (organization_id, lead_id), no un historial
-- completo de intentos (ver la auditoría de HubSpot sobre por qué una
-- tabla tipo outbox/log completa no se justifica para un MVP de
-- sincronización manual). Escrita únicamente por el backend
-- (service_role); nunca por una escritura directa del navegador — ver la
-- sección RLS más abajo.
create table if not exists hubspot_contact_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null,
  -- FK compuesta, no una simple `references leads(id)`: esta es la
  -- garantía de integridad multi-tenant pedida explícitamente para esta
  -- tabla. Una FK simple a leads(id) solo probaría que lead_id referencia
  -- *algún* lead existente — no dice nada sobre si ese lead realmente
  -- pertenece a esta organization_id. Referenciar la clave única compuesta
  -- añadida en el bloque 0 (leads(id, organization_id)) hace
  -- estructuralmente imposible — exigido por Postgres mismo, no por
  -- código de aplicación ni por RLS — insertar una fila que combine el id
  -- de una organización con un lead de otra.
  --
  -- ON DELETE CASCADE: a diferencia de webhook_deliveries (que pone
  -- lead_id en NULL para preservar el historial de entregas), esta tabla
  -- no tiene un propósito de auditoría propio — ES el mapeo actual, así
  -- que una vez que el lead desaparece, el mapeo deja de tener sentido y
  -- debe desaparecer con él.
  foreign key (lead_id, organization_id) references leads (id, organization_id) on delete cascade,
  hubspot_contact_id text not null,
  last_synced_at timestamptz not null default now(),
  last_sync_status text not null check (last_sync_status in ('synced', 'failed')),
  last_sync_error text,
  created_at timestamptz not null default now(),
  unique (organization_id, lead_id)
);

create index if not exists hubspot_contact_links_organization_id_idx
  on hubspot_contact_links (organization_id);

-- ── 4. RLS: hubspot_contact_links ────────────────────────────────────────
alter table hubspot_contact_links enable row level security;
drop policy if exists "hubspot_contact_links_select" on hubspot_contact_links;

-- SELECT: cualquier miembro de la organización (incluido viewer) — mismo
-- razonamiento que webhook_deliveries_select: no hay ninguna sensibilidad
-- adicional aquí más allá de lo que un miembro ya puede ver sobre sus
-- propios leads.
create policy "hubspot_contact_links_select" on hubspot_contact_links for select
  using (is_org_member(organization_id));

-- Deliberadamente SIN política de insert/update/delete para
-- anon/authenticated. Solo el backend Express (service_role, evita RLS)
-- escribe esta tabla — ningún usuario autenticado, en ningún rol, debe
-- poder fabricar o alterar un registro de sincronización directamente.

-- ── verificación ────────────────────────────────────────────────────────
-- 1) Confirmar que ambas tablas y sus columnas existen.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_name in ('hubspot_connections', 'hubspot_contact_links')
order by table_name, ordinal_position;

-- 2) Confirmar que las políticas RLS coinciden con el diseño de arriba.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in ('hubspot_connections', 'hubspot_contact_links')
order by tablename, policyname;

-- 3) Confirmar que la restricción única compuesta sobre `leads` existe.
select conname, contype
from pg_constraint
where conname = 'leads_id_organization_id_key';

-- 4) Confirmar que la FK compuesta de hubspot_contact_links existe y
--    referencia las columnas correctas.
select
  con.conname,
  con.confrelid::regclass as references_table,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
where con.conrelid = 'hubspot_contact_links'::regclass and con.contype = 'f';

-- 5) Prueba manual (una vez que una fase posterior conecte OAuth y el
--    repositorio se use de verdad):
--    - Como 'member'/'viewer' autenticado, `select * from
--      hubspot_connections` directo — debe devolver cero filas, sin
--      siquiera un error de autorización, ya que no existe política
--      SELECT alguna.
--    - Como 'owner'/'admin' de una organización DISTINTA, intentar
--      UPDATE/DELETE sobre la fila hubspot_connections de otra
--      organización directamente — debe fallar por violación de política
--      RLS.
--    - Intentar insertar una fila en hubspot_contact_links combinando el
--      organization_id de una organización con un lead_id que pertenece a
--      otra — debe fallar por violación de la foreign key compuesta, no
--      tener éxito silenciosamente.
--    - Eliminar un lead que tiene una fila en hubspot_contact_links — la
--      fila del mapeo debe eliminarse también (ON DELETE CASCADE), no
--      quedar huérfana.
