-- MAASTAC AI — Comprobación de SOLO LECTURA del despliegue H1/H2.
--
-- Pégalo y ejecútalo en el SQL editor del proyecto ANTES y DESPUÉS de cada
-- etapa (respaldo → H1 → H2 sección A → push → validación → H2 sección B).
-- No modifica nada: solo SELECT sobre el catálogo y recuentos.
--
-- Devuelve una fila por comprobación:
--   etapa_detectada  qué partes de H1/H2 están instaladas ahora mismo
--   OK / ALERTA      cada invariante de seguridad o de funcionamiento
-- Cualquier ALERTA = no avances a la siguiente etapa (ver
-- REPORTE_PREPARACION_DESPLIEGUE_H1_H2.txt, sección 6, para revertir).

with
h1 as (
  select coalesce(bool_or(position('CHAT_SESSION_NOT_FOUND' in prosrc) > 0), false) as installed,
         coalesce(bool_or(has_function_privilege('anon', oid, 'execute')), false) as anon_can_execute
  from pg_proc where pronamespace = 'public'::regnamespace and proname = 'upsert_chat_lead'
),
h2a as (
  select count(*) filter (where proname in ('get_public_form', 'get_public_chat_config')) = 2 as installed,
         coalesce(bool_and(has_function_privilege('anon', oid, 'execute')) filter (where proname in ('get_public_form', 'get_public_chat_config')), false) as anon_can_execute,
         coalesce(bool_and(prosecdef) filter (where proname in ('get_public_form', 'get_public_chat_config')), false) as security_definer
  from pg_proc where pronamespace = 'public'::regnamespace
),
pol as (
  select tablename,
         count(*) filter (where cmd = 'SELECT') as select_policies,
         count(*) filter (where cmd = 'SELECT' and qual = 'true') as public_select_policies
  from pg_policies
  where schemaname = 'public' and tablename in ('organizations', 'forms', 'chat_configuration')
  group by tablename
),
h2b as (
  select coalesce(sum(public_select_policies), 0) = 0 and count(*) = 3 as installed,
         coalesce(sum(public_select_policies), 0) as remaining_public
  from pol
),
checks(orden, comprobacion, estado, detalle) as (
  select 0, 'etapa_detectada', 'INFO',
         case
           when not h1.installed and not h2a.installed and not h2b.installed then '0 · ninguna (estado previo al despliegue)'
           when h1.installed and not h2a.installed and not h2b.installed then '1 · H1 instalada'
           when h1.installed and h2a.installed and not h2b.installed then '2 · H1 + H2 sección A (listo para push / validación)'
           when h1.installed and h2a.installed and h2b.installed then '3 · H1 + H2 completa (A + B)'
           else 'estado no previsto — revisa las ALERTAS'
         end
  from h1, h2a, h2b
  union all
  select 1, 'H1 · upsert_chat_lead sigue ejecutable por el chat público (anon)',
         case when h1.anon_can_execute then 'OK' else 'ALERTA' end,
         case when h1.anon_can_execute then '' else 'sin EXECUTE para anon: el chat público no podrá crear leads' end
  from h1
  union all
  select 2, 'H2-A · si existen las funciones públicas, anon puede ejecutarlas y son SECURITY DEFINER',
         case when not h2a.installed or (h2a.anon_can_execute and h2a.security_definer) then 'OK' else 'ALERTA' end,
         case when not h2a.installed then 'aún no instaladas' when h2a.anon_can_execute and h2a.security_definer then '' else 'permisos incorrectos' end
  from h2a
  union all
  select 3, 'H2-B NUNCA sin H2-A (si no, /f/:formId y /c/:orgSlug dejan de funcionar)',
         case when h2b.installed and not h2a.installed then 'ALERTA' else 'OK' end,
         case when h2b.installed and not h2a.installed then 'políticas cerradas SIN funciones públicas: aplica la sección A ya o revierte B' else '' end
  from h2a, h2b
  union all
  select 4, 'Cada tabla (organizations, forms, chat_configuration) tiene exactamente 1 política SELECT',
         case when (select count(*) from pol where select_policies = 1) = 3 then 'OK' else 'ALERTA' end,
         (select string_agg(tablename || '=' || select_policies, ', ' order by tablename) from pol)
  union all
  select 5, 'H2-B parcial (algunas tablas cerradas y otras públicas)',
         case when h2b.remaining_public in (0, 3) then 'OK' else 'ALERTA' end,
         case when h2b.remaining_public in (0, 3) then '' else h2b.remaining_public || ' tabla(s) siguen públicas' end
  from h2b
  union all
  select 6, 'get_public_form no expone puntuación (sobre un formulario activo real, si hay)',
         case
           when not h2a.installed or not exists (select 1 from forms where status = 'active') then 'OK'
           -- Dynamic SQL (query_to_xml): this script must also parse BEFORE the
           -- function exists, so it is never referenced statically.
           when (xpath('/row/t/text()', query_to_xml(
                   'select questions::text as t from public.get_public_form(' || quote_literal((select id from forms where status = 'active' order by created_at limit 1)) || '::uuid)',
                   false, true, '')))[1]::text like '%points%' then 'ALERTA'
           else 'OK'
         end,
         case when not h2a.installed then 'función aún no instalada' when not exists (select 1 from forms where status = 'active') then 'sin formularios activos que probar' else '' end
  from h2a
)
select comprobacion, estado, detalle from checks order by orden;

-- Recuentos de referencia: compáralos con los de tu instantánea previa.
-- Ninguna etapa de H1/H2 modifica datos: solo deben cambiar por actividad
-- normal de los usuarios.
select 'organizations' as tabla, count(*) as filas from organizations union all
select 'forms', count(*) from forms union all
select 'chat_configuration', count(*) from chat_configuration union all
select 'leads', count(*) from leads union all
select 'lead_activity', count(*) from lead_activity union all
select 'chat_sessions', count(*) from chat_sessions;
