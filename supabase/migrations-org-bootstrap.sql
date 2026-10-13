-- MAASTAC AI (técnicamente "Lead AI") — Aprovisionamiento atómico e
-- idempotente de la organización personal (corrige la duplicación de
-- organizaciones en el primer acceso; ver REPORTE_DUPLICACION_ORGANIZACIONES).
--
-- Antes, OrganizationProvider.tsx creaba la organización personal desde el
-- navegador con cuatro llamadas independientes (listar membresías → crear
-- organización → hacerse owner → crear team_member). Dos ejecuciones casi
-- simultáneas del mismo usuario (React StrictMode en desarrollo, dos
-- pestañas, varios eventos de sesión) veían ambas "0 membresías" y creaban
-- dos organizaciones; un fallo a mitad dejaba organizaciones huérfanas.
--
-- Esta función hace todo en UNA transacción, serializada por usuario:
--   * pg_advisory_xact_lock por usuario: las llamadas concurrentes del MISMO
--     usuario esperan su turno; las de usuarios distintos no se bloquean.
--   * Idempotente: si el usuario ya pertenece a CUALQUIER organización
--     (propia o por invitación), devuelve la más antigua y no crea nada.
--   * Atómica: organización + membresía owner + team_member, todo o nada.
--   * El usuario no elige nada sensible: id = auth.uid(), rol 'owner' fijo,
--     nombre y email derivados del JWT (como accept_invite()).
--
-- No cambia ninguna tabla, política RLS ni función existente. Crear más
-- organizaciones a propósito en el futuro sigue siendo posible (esta
-- función solo resuelve el PRIMER aprovisionamiento; no impone ningún
-- límite de organizaciones por usuario en la base de datos).
--
-- Re-ejecutable. NO ejecutada contra Supabase: aplicar a mano en el SQL
-- editor. schema.sql contiene la misma función para proyectos nuevos.

create or replace function public.bootstrap_personal_organization()
returns table (organization_id uuid, organization_slug text, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- Las columnas de salida (organization_id, …) se llaman igual que columnas
-- reales: dentro de las sentencias SQL, el nombre se refiere a la COLUMNA.
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_email text := nullif(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), '');
  v_base_name text;
  v_org_name text;
  v_base_slug text;
  v_slug text;
  v_org_id uuid;
  v_existing_id uuid;
  v_existing_slug text;
  v_attempt integer;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  -- Serializa a ESTE usuario hasta el final de la transacción. Una segunda
  -- llamada concurrente espera aquí y, al continuar, ve ya confirmada la
  -- membresía de la primera (READ COMMITTED: nuevo snapshot por sentencia).
  perform pg_advisory_xact_lock(hashtext('bootstrap_personal_organization'), hashtext(v_uid::text));

  select m.organization_id, o.slug
    into v_existing_id, v_existing_slug
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = v_uid
  order by m.created_at asc, m.organization_id asc
  limit 1;

  if v_existing_id is not null then
    return query select v_existing_id, v_existing_slug, false;
    return;
  end if;

  -- Mismo criterio que deriveOrganizationName() en el frontend: full_name,
  -- si no la parte local del email, si no un texto genérico.
  v_base_name := coalesce(
    nullif(trim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
    nullif(split_part(coalesce(v_email, ''), '@', 1), ''),
    'Mi organización'
  );
  v_base_name := left(v_base_name, 120);
  v_org_name := 'Organización de ' || v_base_name;

  -- Slug equivalente al slugify() del frontend: minúsculas, sin acentos,
  -- solo [a-z0-9-]. Reintenta con sufijo aleatorio si el slug ya existe.
  v_base_slug := regexp_replace(
    translate(lower(v_org_name), 'áàäâãåéèëêíìïîóòöôõúùüûñç', 'aaaaaaeeeeiiiiooooouuuunc'),
    '[^a-z0-9]+', '-', 'g'
  );
  v_base_slug := trim(both '-' from v_base_slug);
  if v_base_slug = '' then
    v_base_slug := 'org';
  end if;

  for v_attempt in 0..9 loop
    v_slug := case when v_attempt = 0 then v_base_slug
                   else v_base_slug || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4) end;
    insert into public.organizations (name, slug, created_by)
    values (v_org_name, v_slug, v_uid)
    on conflict (slug) do nothing
    returning id into v_org_id;
    exit when v_org_id is not null;
  end loop;

  if v_org_id is null then
    raise exception 'ORG_SLUG_UNAVAILABLE';
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org_id, v_uid, 'owner');

  -- team_member del owner para que "Persona asignada" no esté vacío. Sin
  -- email en el JWT (p. ej. acceso por teléfono) no se crea, igual que antes.
  if v_email is not null then
    insert into public.team_members (organization_id, name, email, role)
    values (v_org_id, v_base_name, v_email, 'owner')
    on conflict (organization_id, email) do nothing;
  end if;

  return query select v_org_id, v_slug, true;
end;
$$;

-- Solo usuarios autenticados. anon y PUBLIC no pueden ejecutarla (Supabase
-- concede EXECUTE a anon/authenticated por defecto: se revoca explícitamente).
revoke all on function public.bootstrap_personal_organization() from public, anon, authenticated;
grant execute on function public.bootstrap_personal_organization() to authenticated;

-- ── verificación (solo lectura) ────────────────────────────────────────────
-- SECURITY DEFINER con search_path fijado; anon sin EXECUTE; authenticated sí.
select proname, prosecdef, proconfig,
       has_function_privilege('anon', oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', oid, 'execute') as authenticated_can_execute
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'bootstrap_personal_organization';

-- Usuarios con más de una organización creada por ellos mismos (duplicados
-- previos a esta corrección). Solo informativo: esta migración NO borra nada.
select created_by, count(*) as organizations, array_agg(slug order by created_at) as slugs
from public.organizations
where created_by is not null
group by created_by
having count(*) > 1;

-- ── reversión (NO ejecutar salvo que se quiera deshacer) ───────────────────
-- Antes, volver a desplegar el frontend anterior: el actual llama a esta
-- función en el primer acceso de cada usuario.
-- drop function if exists public.bootstrap_personal_organization();
