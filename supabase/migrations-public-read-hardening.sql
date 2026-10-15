-- MAASTAC AI (técnicamente "Lead AI") — Lectura pública mínima de
-- organizations, forms y chat_configuration (hallazgo H2 de
-- REPORTE_AVANCE_MVP / REPORTE_SEGURIDAD_MVP).
--
-- Antes, las tres tablas tenían una política SELECT `using (true)` para que
-- las páginas sin sesión (/f/:formId y /c/:orgSlug) pudieran leerlas. Eso
-- exponía a cualquiera, para TODAS las organizaciones a la vez:
--   * organizations: support_email, created_by (id del usuario propietario),
--     tipo de negocio, estado del onboarding;
--   * forms: formularios en BORRADOR y la puntuación (points) de cada
--     pregunta y opción, es decir, los criterios de calificación;
--   * chat_configuration: descripción del negocio, servicios, criterios de
--     calificación, preguntas a recoger e instrucciones adicionales del
--     asistente.
--
-- Después de esta migración:
--   * Las tres tablas solo son legibles por los MIEMBROS de cada organización
--     (is_org_member). organizations además por su CREADOR (created_by =
--     auth.uid()), para que createOrganization() pueda leer la fila que
--     acaba de insertar antes de añadirse como owner.
--   * Las páginas públicas usan dos funciones con la salida mínima:
--       get_public_form(id)         → solo formularios ACTIVOS; preguntas sin
--                                     puntuación (points eliminados).
--       get_public_chat_config(slug) → id de la organización, nombre del
--                                     asistente, bienvenida, tono, idioma y
--                                     si está activo. Nada más.
--   * El backend no cambia: lee con la clave de servicio, que no usa RLS, y
--     es quien calcula la puntuación de los formularios y carga la
--     configuración completa del chat.
--
-- Funciones de base de datos que leían estas tablas siendo anónimas: todas
-- son SECURITY DEFINER (get_invite_by_token, accept_invite,
-- create_public_chat_session, append_chat_message,
-- bootstrap_personal_organization), así que no se ven afectadas. La política
-- de inserción de organization_members consulta organizations como creador:
-- sigue funcionando gracias a la rama created_by.
--
-- REQUIERE desplegar a la vez el frontend que usa get_public_form() y
-- get_public_chat_config() (form-supabase-repository.ts,
-- chat-config-supabase-repository.ts). Con el frontend anterior, las páginas
-- públicas /f/:formId y /c/:orgSlug dejarían de encontrar el formulario o el
-- chat. Orden recomendado: 1) crear SOLO las dos funciones (sección A,
-- inocua); 2) desplegar el frontend; 3) aplicar la sección B (políticas).
--
-- Re-ejecutable. NO ejecutada contra Supabase: aplicar a mano en el SQL
-- editor, primero en STAGING. schema.sql contiene lo mismo para proyectos
-- nuevos. Pruebas: supabase/tests-security-h1-h2.sql, en un Postgres
-- desechable.

-- ── A. Funciones públicas (inocuas: no quitan ningún acceso) ──────────────

create or replace function public.get_public_form(p_form_id uuid)
returns table (
  id uuid,
  organization_id uuid,
  name text,
  description text,
  status text,
  questions jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    f.id,
    f.organization_id,
    f.name,
    f.description,
    f.status,
    -- Scoring stays private: drop `points` from every question and option.
    coalesce((
      select jsonb_agg(
        case
          when jsonb_typeof(q.value -> 'options') = 'array' then
            (q.value - 'points') || jsonb_build_object('options', coalesce((
              select jsonb_agg(o.value - 'points' order by o.ordinality)
              from jsonb_array_elements(q.value -> 'options') with ordinality as o(value, ordinality)
            ), '[]'::jsonb))
          else q.value - 'points'
        end
        order by q.ordinality
      )
      from jsonb_array_elements(f.questions) with ordinality as q(value, ordinality)
    ), '[]'::jsonb),
    f.created_at,
    f.updated_at
  from forms f
  where f.id = p_form_id
    and f.status = 'active'
$$;

revoke all on function public.get_public_form(uuid) from public;
grant execute on function public.get_public_form(uuid) to anon, authenticated;

create or replace function public.get_public_chat_config(p_slug text)
returns table (
  organization_id uuid,
  assistant_name text,
  welcome_message text,
  tone text,
  language text,
  is_active boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, cc.assistant_name, cc.welcome_message, cc.tone, cc.language, cc.is_active
  from organizations o
  join chat_configuration cc on cc.organization_id = o.id
  where o.slug = p_slug
$$;

revoke all on function public.get_public_chat_config(text) from public;
grant execute on function public.get_public_chat_config(text) to anon, authenticated;

-- ── B. Políticas: solo miembros (aplicar DESPUÉS de desplegar el frontend) ──

drop policy if exists "organizations_select_public" on organizations;
drop policy if exists "organizations_select_members" on organizations;
create policy "organizations_select_members" on organizations for select
  using (is_org_member(id) or created_by = auth.uid());

drop policy if exists "forms_select" on forms;
create policy "forms_select" on forms for select
  using (is_org_member(organization_id));

drop policy if exists "chat_configuration_select" on chat_configuration;
create policy "chat_configuration_select" on chat_configuration for select
  using (is_org_member(organization_id));

-- ── verificación (solo lectura) ────────────────────────────────────────────
select tablename, policyname, qual
from pg_policies
where schemaname = 'public'
  and tablename in ('organizations', 'forms', 'chat_configuration')
  and cmd = 'SELECT'
order by tablename;

select proname, prosecdef,
       has_function_privilege('anon', oid, 'execute') as anon_can_execute
from pg_proc
where pronamespace = 'public'::regnamespace and proname in ('get_public_form', 'get_public_chat_config');

-- ── reversión (NO ejecutar salvo que se quiera deshacer) ───────────────────
-- Reabre el hallazgo H2. Las funciones pueden quedarse (no exponen nada más).
-- drop policy if exists "organizations_select_members" on organizations;
-- create policy "organizations_select_public" on organizations for select using (true);
-- drop policy if exists "forms_select" on forms;
-- create policy "forms_select" on forms for select using (true);
-- drop policy if exists "chat_configuration_select" on chat_configuration;
-- create policy "chat_configuration_select" on chat_configuration for select using (true);
