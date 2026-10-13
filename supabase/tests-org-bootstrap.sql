-- Pruebas de bootstrap_personal_organization() (migrations-org-bootstrap.sql).
--
-- Para un Postgres desechable o STAGING, nunca producción. Todo corre en
-- una transacción que termina en ROLLBACK: crea sus propios usuarios de
-- prueba en auth.users y no deja rastro. Cada bloque usa `assert`.
-- La concurrencia real (varias conexiones a la vez) no cabe en un único
-- script: ver el procedimiento manual al final.

begin;

-- ── preparación: usuarios de prueba ───────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  ('b0000000-0000-4000-8000-000000000001', 'ana.prueba@example.com', '{"full_name":"Ana Prueba"}'),
  ('b0000000-0000-4000-8000-000000000002', 'bob@example.com', '{}'),
  ('b0000000-0000-4000-8000-000000000003', 'carla.invitada@example.com', '{"full_name":"Carla"}'),
  ('b0000000-0000-4000-8000-000000000004', 'dani.fallo@example.com', '{"full_name":"Dani"}'),
  ('b0000000-0000-4000-8000-000000000005', null, '{}');

-- ── B1: anon no puede ejecutarla ──────────────────────────────────────────
do $$
begin
  set local role anon;
  begin
    perform public.bootstrap_personal_organization();
    reset role;
    assert false, 'B1 anon pudo ejecutar bootstrap_personal_organization';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- ── B2: authenticated SIN usuario en el JWT → AUTH_REQUIRED ───────────────
do $$
begin
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.bootstrap_personal_organization();
    reset role;
    assert false, 'B2 sin auth.uid() no falló';
  exception when insufficient_privilege then
    reset role;
    assert sqlerrm = 'AUTH_REQUIRED', 'B2 mensaje inesperado: ' || sqlerrm;
  end;
  reset role;
end $$;

-- ── B3: primer acceso → crea organización + owner + team_member ──────────
do $$
declare
  v_uid uuid := 'b0000000-0000-4000-8000-000000000001';
  r record;
  o public.organizations%rowtype;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated',
    'email', 'Ana.Prueba@Example.com', 'user_metadata', jsonb_build_object('full_name', 'Ana Prueba'))::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  select * into r from public.bootstrap_personal_organization();
  reset role;

  assert r.created, 'B3 no indicó creación';
  select * into o from public.organizations where id = r.organization_id;
  assert o.name = 'Organización de Ana Prueba', 'B3 nombre: ' || o.name;
  assert o.slug = 'organizacion-de-ana-prueba' and r.organization_slug = o.slug, 'B3 slug: ' || o.slug;
  assert o.created_by = v_uid, 'B3 created_by';
  assert (select count(*) from public.organization_members
          where organization_id = o.id and user_id = v_uid and role = 'owner') = 1, 'B3 membresía owner';
  assert (select count(*) from public.organization_members where organization_id = o.id) = 1, 'B3 membresías extra';
  assert exists (select 1 from public.team_members
                 where organization_id = o.id and email = 'ana.prueba@example.com' and name = 'Ana Prueba' and role = 'owner'),
         'B3 team_member del owner (email en minúsculas)';
end $$;

-- ── B4: segunda llamada → idempotente, misma organización, nada nuevo ────
do $$
declare
  v_uid uuid := 'b0000000-0000-4000-8000-000000000001';
  r1 record;
  r2 record;
  v_orgs integer;
  v_members integer;
  v_team integer;
begin
  select count(*) into v_orgs from public.organizations where created_by = v_uid;
  select count(*) into v_members from public.organization_members where user_id = v_uid;
  select count(*) into v_team from public.team_members where email = 'ana.prueba@example.com';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated',
    'email', 'ana.prueba@example.com', 'user_metadata', jsonb_build_object('full_name', 'Ana Prueba'))::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  select * into r1 from public.bootstrap_personal_organization();
  select * into r2 from public.bootstrap_personal_organization();
  reset role;

  assert not r1.created and not r2.created, 'B4 volvió a crear';
  assert r1.organization_id = r2.organization_id, 'B4 devolvió organizaciones distintas';
  assert (select count(*) from public.organizations where created_by = v_uid) = v_orgs, 'B4 organizaciones nuevas';
  assert (select count(*) from public.organization_members where user_id = v_uid) = v_members, 'B4 membresías nuevas';
  assert (select count(*) from public.team_members where email = 'ana.prueba@example.com') = v_team, 'B4 team_members nuevos';
end $$;

-- ── B5: colisión de slug con OTRA organización → sufijo, sin error ───────
-- Sin full_name: el nombre sale de la parte local del email ("bob").
insert into public.organizations (name, slug) values ('Ajena', 'organizacion-de-bob');
do $$
declare
  v_uid uuid := 'b0000000-0000-4000-8000-000000000002';
  r record;
  o public.organizations%rowtype;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated',
    'email', 'bob@example.com', 'user_metadata', '{}'::jsonb)::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  select * into r from public.bootstrap_personal_organization();
  reset role;

  select * into o from public.organizations where id = r.organization_id;
  assert r.created and o.name = 'Organización de bob', 'B5 nombre: ' || o.name;
  assert o.slug ~ '^organizacion-de-bob-[0-9a-f]{4}$', 'B5 slug sin sufijo: ' || o.slug;
  assert (select name from public.organizations where slug = 'organizacion-de-bob') = 'Ajena', 'B5 tocó la organización ajena';
end $$;

-- ── B6: usuario SIN email → nombre genérico y sin team_member ────────────
do $$
declare
  v_uid uuid := 'b0000000-0000-4000-8000-000000000005';
  r record;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  select * into r from public.bootstrap_personal_organization();
  reset role;

  assert r.created and (select name from public.organizations where id = r.organization_id) = 'Organización de Mi organización',
         'B6 nombre genérico';
  assert not exists (select 1 from public.team_members where organization_id = r.organization_id), 'B6 creó team_member sin email';
  assert exists (select 1 from public.organization_members where organization_id = r.organization_id and user_id = v_uid and role = 'owner'),
         'B6 membresía owner';
end $$;

-- ── B7: usuario que ya entró por INVITACIÓN → no crea organización propia ──
do $$
declare
  v_uid uuid := 'b0000000-0000-4000-8000-000000000003';
  v_inviting uuid;
  r record;
begin
  insert into public.organizations (name, slug) values ('Agencia que invita', 'agencia-que-invita-b7') returning id into v_inviting;
  insert into public.organization_members (organization_id, user_id, role) values (v_inviting, v_uid, 'member');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated',
    'email', 'carla.invitada@example.com', 'user_metadata', jsonb_build_object('full_name', 'Carla'))::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  select * into r from public.bootstrap_personal_organization();
  reset role;

  assert not r.created and r.organization_id = v_inviting, 'B7 no devolvió la organización de la invitación';
  assert not exists (select 1 from public.organizations where created_by = v_uid), 'B7 creó una organización personal';
  -- El rol de la invitación no cambia.
  assert (select role from public.organization_members where organization_id = v_inviting and user_id = v_uid) = 'member', 'B7 cambió el rol';
end $$;

-- ── B8: ATOMICIDAD — si falla un paso, no queda nada ─────────────────────
create function pg_temp.fail_team_member_insert() returns trigger language plpgsql as $$
begin
  raise exception 'FALLO_FORZADO_B8';
end $$;
create trigger b8_fail before insert on public.team_members
  for each row when (new.email = 'dani.fallo@example.com') execute function pg_temp.fail_team_member_insert();
do $$
declare
  v_uid uuid := 'b0000000-0000-4000-8000-000000000004';
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated',
    'email', 'dani.fallo@example.com', 'user_metadata', jsonb_build_object('full_name', 'Dani'))::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  begin
    perform public.bootstrap_personal_organization();
    reset role;
    assert false, 'B8 el fallo forzado no se propagó';
  exception when raise_exception then
    reset role;
    assert sqlerrm = 'FALLO_FORZADO_B8', 'B8 error inesperado: ' || sqlerrm;
  end;
  reset role;
  assert not exists (select 1 from public.organizations where created_by = v_uid), 'B8 quedó una organización huérfana';
  assert not exists (select 1 from public.organization_members where user_id = v_uid), 'B8 quedó una membresía';
end $$;
drop trigger b8_fail on public.team_members;

-- ── B9: configuración y privilegios ──────────────────────────────────────
do $$
declare p record;
begin
  select prosecdef, proconfig into p from pg_proc
  where pronamespace = 'public'::regnamespace and proname = 'bootstrap_personal_organization';
  assert p.prosecdef, 'B9 no es SECURITY DEFINER';
  assert p.proconfig @> array['search_path=public, pg_temp'], 'B9 search_path no fijado: ' || p.proconfig::text;
  assert not has_function_privilege('anon', 'public.bootstrap_personal_organization()', 'execute'), 'B9 anon tiene EXECUTE';
  assert not has_function_privilege('public', 'public.bootstrap_personal_organization()', 'execute'), 'B9 PUBLIC tiene EXECUTE';
  assert has_function_privilege('authenticated', 'public.bootstrap_personal_organization()', 'execute'), 'B9 authenticated sin EXECUTE';
end $$;

-- ── B10: regresión — RLS y lecturas normales del frontend siguen igual ───
-- El usuario de B3 lee su membresía con la misma consulta que
-- listMyMemberships() y NO ve las organizaciones de otros (B5/B7).
do $$
declare
  v_uid uuid := 'b0000000-0000-4000-8000-000000000001';
  v_count integer;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  set local role authenticated;
  select count(*) into v_count from public.organization_members where user_id = v_uid;
  assert v_count = 1, 'B10 el usuario no ve exactamente su membresía: ' || v_count;
  select count(*) into v_count from public.organization_members;
  assert v_count = 1, 'B10 RLS dejó ver membresías ajenas: ' || v_count;
  reset role;
end $$;

select 'TODAS LAS PRUEBAS DE APROVISIONAMIENTO PASARON' as resultado;

rollback;

-- ── Prueba manual de CONCURRENCIA (Postgres desechable / staging) ────────
-- Objetivo: N llamadas simultáneas del MISMO usuario → exactamente 1
-- organización, 1 membresía y 1 team_member.
-- Requiere datos confirmados y varias conexiones a la vez. Con un usuario
-- de prueba confirmado en auth.users (id <U>, email <E>), lanzar en
-- paralelo, desde varias conexiones (p. ej. varios psql en segundo plano):
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<U>','role','authenticated','email','<E>')::text, true);
--   select set_config('request.jwt.claim.sub', '<U>', true);
--   set local role authenticated;
--   select * from public.bootstrap_personal_organization();
--   select pg_sleep(2);   -- mantiene la transacción (y el bloqueo) abierta
--   commit;
--
-- Esperado: exactamente UNA conexión devuelve created = true; las demás
-- esperan al bloqueo y devuelven created = false con el MISMO
-- organization_id. Verificar después:
--   select count(*) from public.organizations where created_by = '<U>';        -- 1
--   select count(*) from public.organization_members where user_id = '<U>';    -- 1
--   select count(*) from public.team_members where email = '<E>';             -- 1
-- Repetir con usuarios DISTINTOS en paralelo: no deben esperarse entre sí.
