-- Lead AI — HubSpot CRM integration, Fase 2: estado (`state`) de OAuth.
--
-- Alcance: ÚNICAMENTE la tabla hubspot_oauth_states y su RLS. Sin cambios a
-- hubspot_connections/hubspot_contact_links (Fase 1) ni a nada de Webhooks.
-- NO ejecutada contra Supabase — preparada para revisión y aplicación
-- manual, igual que el resto de migraciones de este proyecto.
--
-- Por qué una tabla y no un Map en memoria: Railway puede reiniciar el
-- proceso del backend en cualquier momento (deploy, crash, restart manual)
-- entre el instante en que /oauth/start genera el `state` y el instante en
-- que HubSpot redirige de vuelta a /oauth/callback — un Map en memoria
-- perdería el `state` en ese reinicio y el callback fallaría de forma
-- indistinguible de un ataque. Además, con más de una instancia del backend
-- (fuera de alcance hoy, pero el mismo motivo que ya aplica a
-- claim_webhook_deliveries), un Map local no sería visible entre procesos.
-- Una tabla en Postgres, consumida con una única sentencia UPDATE atómica,
-- resuelve ambos problemas con el mismo patrón que ya usa el resto del
-- proyecto.
--
-- Ejecutar una sola vez, sobre un proyecto que ya corrió
-- migrations-hubspot.sql (Fase 1) — no depende de ninguna tabla de esa
-- migración salvo `organizations`, que ya existe desde antes.

create table if not exists hubspot_oauth_states (
  -- El propio valor aleatorio del `state` ES la clave primaria — no hace
  -- falta un id separado, y buscarlo por su valor (lo único que el
  -- callback de HubSpot nos da) es la única consulta que esta tabla sirve.
  state text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Quién inició el flujo — vuelve a verificarse como admin en el momento
  -- del callback (el rol pudo cambiar en la ventana de vida del state),
  -- nunca se confía en él por sí solo.
  user_id uuid not null,
  created_at timestamptz not null default now(),
  -- Vida corta (10 minutos, aplicado por la capa de aplicación al insertar
  -- esta fila) — suficiente para que un admin complete el consentimiento en
  -- HubSpot, corto para minimizar la ventana de un `state` interceptado.
  expires_at timestamptz not null,
  -- NULL = todavía no usado. Se estampa en el mismo UPDATE atómico que lo
  -- consume — ver hubspot-repository.ts::consumeOauthState(). Un `state` ya
  -- consumido, o vencido, nunca vuelve a ser válido: no hay camino de
  -- reintento sobre la misma fila, el admin simplemente repite "Conectar"
  -- desde cero.
  consumed_at timestamptz
);

-- Consulta de limpieza ocasional (no automatizada en esta fase — ver nota
-- al final del archivo): filas vencidas/consumidas no representan ningún
-- riesgo de seguridad si se acumulan (nunca vuelven a ser válidas), solo
-- ocupan espacio.
create index if not exists hubspot_oauth_states_expires_at_idx
  on hubspot_oauth_states (expires_at);

alter table hubspot_oauth_states enable row level security;

-- Deliberadamente CERO políticas — ni siquiera SELECT para
-- anon/authenticated. Esta tabla no tiene ningún consumidor legítimo desde
-- el navegador: el `state` se genera, se guarda y se consume enteramente
-- server-side (service_role, que evita RLS). Con RLS habilitado y sin
-- ninguna política, cualquier intento directo de leer o escribir esta tabla
-- vía la API REST de Supabase, con cualquier rol autenticado o anónimo,
-- devuelve cero filas / es rechazado — igual que hubspot_connections en
-- Fase 1.

-- ── verificación ────────────────────────────────────────────────────────
-- 1) Confirmar que la tabla y sus columnas existen.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'hubspot_oauth_states'
order by ordinal_position;

-- 2) Confirmar que RLS está habilitado y que no hay ninguna política.
select relrowsecurity from pg_class where relname = 'hubspot_oauth_states';
select policyname from pg_policies where tablename = 'hubspot_oauth_states';
-- La segunda consulta debe devolver CERO filas — esa es la confirmación
-- correcta, no un error.

-- Nota — limpieza de filas vencidas: esta migración no incluye un job
-- automático de limpieza (sería sobrearquitectura para esta fase — las
-- filas vencidas/consumidas son inertes, nunca vuelven a validar). Si el
-- volumen de conexiones OAuth crece mucho, un `delete from
-- hubspot_oauth_states where expires_at < now() - interval '1 day'`
-- ejecutado ocasionalmente (o programado más adelante) es suficiente.
