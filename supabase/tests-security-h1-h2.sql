-- Pruebas de seguridad de migrations-chat-lead-isolation.sql (H1) y
-- migrations-public-read-hardening.sql (H2).
--
-- SOLO para un Postgres DESECHABLE (o staging con autorización), nunca para
-- producción. Todo corre en una transacción que termina en ROLLBACK: crea
-- sus propios usuarios, organizaciones, formularios y sesiones de prueba y
-- no deja rastro. Cada bloque usa `assert`: si algo falla, el script se
-- detiene con el mensaje correspondiente.
--
-- Simula los roles de Supabase con `set local role` + los claims del JWT
-- (request.jwt.claim.sub / request.jwt.claims), como hace PostgREST.
-- Requiere auth.jwt() (existe en Supabase; en una imagen de Postgres sin el
-- stack completo, créala antes: ver la cabecera de tests-org-bootstrap.sql).

begin;

-- ── preparación (como postgres) ───────────────────────────────────────────
insert into auth.users (id, email) values
  ('5ec00000-0000-4000-8000-0000000000a1', 'member-a@example.test'),
  ('5ec00000-0000-4000-8000-0000000000b1', 'member-b@example.test'),
  ('5ec00000-0000-4000-8000-0000000000c1', 'creator-c@example.test');

insert into organizations (id, name, slug, support_email) values
  ('5ec00000-0000-4000-8000-00000000000a', 'Sec Org A', 'sec-org-a-91f2', 'a@example.test'),
  ('5ec00000-0000-4000-8000-00000000000b', 'Sec Org B', 'sec-org-b-91f2', 'b@example.test');
insert into organization_members (organization_id, user_id, role) values
  ('5ec00000-0000-4000-8000-00000000000a', '5ec00000-0000-4000-8000-0000000000a1', 'owner'),
  ('5ec00000-0000-4000-8000-00000000000b', '5ec00000-0000-4000-8000-0000000000b1', 'owner');

insert into chat_configuration (organization_id, assistant_name, welcome_message, tone, agency_description, additional_instructions, criteria, is_active) values
  ('5ec00000-0000-4000-8000-00000000000a', 'Asistente A', 'Hola A', 'friendly', 'Descripción interna A', 'INSTRUCCION INTERNA A', '[{"id":"c1","label":"Presupuesto","weight":50}]', true),
  ('5ec00000-0000-4000-8000-00000000000b', 'Asistente B', 'Hola B', 'professional', 'Descripción interna B', 'INSTRUCCION INTERNA B', '[]', true);

insert into forms (id, organization_id, name, status, questions) values
  ('5ec00000-0000-4000-8000-0000000000f1', '5ec00000-0000-4000-8000-00000000000a', 'Activo A', 'active',
   '[{"id":"q1","type":"email","label":"Email","required":true,"points":5},
     {"id":"q2","type":"single_choice","label":"Presupuesto","required":true,"points":0,
      "options":[{"id":"o1","label":"Bajo","points":10},{"id":"o2","label":"Alto","points":40}]}]'),
  ('5ec00000-0000-4000-8000-0000000000f2', '5ec00000-0000-4000-8000-00000000000a', 'Borrador A', 'draft', '[]'),
  ('5ec00000-0000-4000-8000-0000000000f3', '5ec00000-0000-4000-8000-00000000000b', 'Activo B', 'active', '[]');

-- ════════════════════════════════════════════════════════════════════════
-- H1 — upsert_chat_lead
-- ════════════════════════════════════════════════════════════════════════

set local role anon;
select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{"role":"anon"}', true);

-- Sesiones de chat creadas por la vía pública real.
select public.create_public_chat_session('5ec00000-0000-4000-8000-0000000005a1', '5ec00000-0000-4000-8000-00000000000a', 'sec-org-a-91f2');
select public.create_public_chat_session('5ec00000-0000-4000-8000-0000000005b1', '5ec00000-0000-4000-8000-00000000000b', 'sec-org-b-91f2');

-- H1-1: caso legítimo — crear y luego actualizar el lead de la propia sesión.
do $$
declare v leads;
begin
  v := public.upsert_chat_lead('5ec00000-0000-4000-8000-00000000000a', '5ec00000-0000-4000-8000-0000000005a1',
                               'Ana', 'ana@a.test', '', '', 'qualifying', 50, null);
  assert v.organization_id = '5ec00000-0000-4000-8000-00000000000a' and v.status = 'qualifying', 'H1-1 creación legítima falló';
  v := public.upsert_chat_lead('5ec00000-0000-4000-8000-00000000000a', '5ec00000-0000-4000-8000-0000000005a1',
                               'Ana', 'ana@a.test', '', '', 'qualified', 85, null);
  assert v.status = 'qualified' and v.score = 85, 'H1-1 actualización legítima falló';
end $$;

-- Lead legítimo de B (su propia sesión).
do $$
begin
  perform public.upsert_chat_lead('5ec00000-0000-4000-8000-00000000000b', '5ec00000-0000-4000-8000-0000000005b1',
                                  'Bea', 'bea@b.test', '', '', 'qualified', 90, null);
end $$;

-- H1-2..H1-5: cada intento indebido falla con CHAT_SESSION_NOT_FOUND.
do $$
declare
  v_case record;
  v_failed boolean;
begin
  for v_case in
    select * from (values
      ('H1-2 sesión inexistente',                 '5ec00000-0000-4000-8000-00000000000a'::uuid, '5ec00000-0000-4000-8000-0000000005ff'),
      ('H1-3 id de sesión que no es uuid',        '5ec00000-0000-4000-8000-00000000000a'::uuid, 'no-es-un-uuid'),
      ('H1-4 sesión de B con organización A',     '5ec00000-0000-4000-8000-00000000000a'::uuid, '5ec00000-0000-4000-8000-0000000005b1'),
      ('H1-5 sesión de A con organización B',     '5ec00000-0000-4000-8000-00000000000b'::uuid, '5ec00000-0000-4000-8000-0000000005a1')
    ) as t(label, org, session)
  loop
    v_failed := false;
    begin
      perform public.upsert_chat_lead(v_case.org, v_case.session, 'X', 'x@x.test', '', '', 'disqualified', 0, 'x');
    exception when others then
      assert sqlerrm = 'CHAT_SESSION_NOT_FOUND', v_case.label || ': error inesperado ' || sqlerrm;
      v_failed := true;
    end;
    assert v_failed, v_case.label || ': la llamada NO falló';
  end loop;
end $$;

reset role;

-- H1-6: los leads reales quedaron intactos y no apareció ningún lead extra.
do $$
begin
  assert (select count(*) from leads where organization_id = '5ec00000-0000-4000-8000-00000000000a') = 1, 'H1-6 leads extra en A';
  assert (select count(*) from leads where organization_id = '5ec00000-0000-4000-8000-00000000000b') = 1, 'H1-6 leads extra en B';
  assert (select name = 'Bea' and email = 'bea@b.test' and score = 90
          from leads where chat_session_id = '5ec00000-0000-4000-8000-0000000005b1'), 'H1-6 el lead de B fue modificado';
  assert (select name = 'Ana' and score = 85
          from leads where chat_session_id = '5ec00000-0000-4000-8000-0000000005a1'), 'H1-6 el lead de A fue modificado';
  -- 2 actividades de A (creación + actualización) y 1 de B; nada de los intentos fallidos.
  assert (select count(*) from lead_activity where organization_id = '5ec00000-0000-4000-8000-00000000000a') = 2, 'H1-6 actividad inesperada en A';
  assert (select count(*) from lead_activity where organization_id = '5ec00000-0000-4000-8000-00000000000b') = 1, 'H1-6 actividad inesperada en B';
end $$;

-- ════════════════════════════════════════════════════════════════════════
-- H2 — lectura pública mínima
-- ════════════════════════════════════════════════════════════════════════

-- H2-1: anon no lee ninguna fila de las tres tablas.
set local role anon;
select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  assert (select count(*) from organizations) = 0, 'H2-1 anon lee organizations';
  assert (select count(*) from forms) = 0, 'H2-1 anon lee forms';
  assert (select count(*) from chat_configuration) = 0, 'H2-1 anon lee chat_configuration';
end $$;

-- H2-2: get_public_form — solo activos y sin puntuación.
do $$
declare v_questions jsonb;
begin
  select questions into v_questions from public.get_public_form('5ec00000-0000-4000-8000-0000000000f1');
  assert v_questions is not null, 'H2-2 formulario activo no encontrado';
  assert jsonb_array_length(v_questions) = 2, 'H2-2 faltan preguntas';
  assert v_questions::text not like '%points%', 'H2-2 la puntuación sigue visible';
  assert v_questions -> 0 ->> 'id' = 'q1' and v_questions -> 1 ->> 'id' = 'q2', 'H2-2 orden de preguntas alterado';
  assert v_questions -> 1 -> 'options' -> 1 ->> 'label' = 'Alto', 'H2-2 opciones alteradas';
  assert (v_questions -> 0 ->> 'required')::boolean and v_questions -> 0 ->> 'type' = 'email', 'H2-2 campos necesarios perdidos';
  assert not exists (select 1 from public.get_public_form('5ec00000-0000-4000-8000-0000000000f2')), 'H2-2 un BORRADOR es público';
  assert not exists (select 1 from public.get_public_form('5ec00000-0000-4000-8000-0000000000ff')), 'H2-2 id inexistente devolvió algo';
end $$;

-- H2-3: get_public_chat_config — solo los campos públicos.
do $$
declare v record; v_json jsonb;
begin
  select * into v from public.get_public_chat_config('sec-org-a-91f2');
  assert v.organization_id = '5ec00000-0000-4000-8000-00000000000a' and v.assistant_name = 'Asistente A'
         and v.welcome_message = 'Hola A' and v.is_active, 'H2-3 configuración pública incorrecta';
  select to_jsonb(c) into v_json from public.get_public_chat_config('sec-org-a-91f2') c;
  assert (select array_agg(k order by k) from jsonb_object_keys(v_json) k)
         = array['assistant_name', 'is_active', 'language', 'organization_id', 'tone', 'welcome_message'],
         'H2-3 la función devuelve columnas no públicas';
  assert v_json::text not like '%INTERNA%' and v_json::text not like '%Presupuesto%', 'H2-3 se filtran datos internos';
  assert not exists (select 1 from public.get_public_chat_config('no-existe-91f2')), 'H2-3 slug inexistente devolvió algo';
end $$;
reset role;

-- H2-4: un miembro de A ve lo suyo (dashboard intacto) y nada de B.
set local role authenticated;
select set_config('request.jwt.claim.sub', '5ec00000-0000-4000-8000-0000000000a1', true),
       set_config('request.jwt.claims', '{"sub":"5ec00000-0000-4000-8000-0000000000a1","role":"authenticated","email":"member-a@example.test"}', true);
do $$
begin
  assert (select count(*) from organizations) = 1, 'H2-4 el miembro de A no ve exactamente su organización';
  assert (select count(*) from forms where organization_id = '5ec00000-0000-4000-8000-00000000000a') = 2, 'H2-4 el miembro de A no ve sus formularios (borrador incluido)';
  assert (select count(*) from forms where organization_id = '5ec00000-0000-4000-8000-00000000000b') = 0, 'H2-4 el miembro de A ve formularios de B';
  assert (select additional_instructions from chat_configuration where organization_id = '5ec00000-0000-4000-8000-00000000000a') = 'INSTRUCCION INTERNA A',
         'H2-4 el miembro de A no ve su configuración completa';
  assert (select count(*) from chat_configuration where organization_id = '5ec00000-0000-4000-8000-00000000000b') = 0, 'H2-4 el miembro de A ve la configuración de B';
  assert (select (q -> 'options' -> 1 ->> 'points')::int from forms f, jsonb_array_elements(f.questions) q
          where f.id = '5ec00000-0000-4000-8000-0000000000f1' and q ->> 'id' = 'q2') = 40, 'H2-4 el miembro perdió la puntuación en el editor';
end $$;

-- H2-5: el miembro de A sigue pudiendo escribir y leer de vuelta (onboarding, editor, ajustes).
do $$
declare v_id uuid;
begin
  insert into forms (organization_id, name, status, questions)
  values ('5ec00000-0000-4000-8000-00000000000a', 'Nuevo A', 'draft', '[]') returning id into v_id;
  assert v_id is not null, 'H2-5 no se pudo crear un formulario';
  update chat_configuration set welcome_message = 'Hola A2' where organization_id = '5ec00000-0000-4000-8000-00000000000a';
  assert (select welcome_message from chat_configuration where organization_id = '5ec00000-0000-4000-8000-00000000000a') = 'Hola A2',
         'H2-5 no se pudo actualizar la configuración';
  -- Escribir en B sigue prohibido.
  update chat_configuration set welcome_message = 'pwn' where organization_id = '5ec00000-0000-4000-8000-00000000000b';
end $$;
reset role;
do $$
begin
  assert (select welcome_message from chat_configuration where organization_id = '5ec00000-0000-4000-8000-00000000000b') = 'Hola B',
         'H2-5 un miembro de A modificó la configuración de B';
end $$;

-- H2-6: un usuario recién creado (sin membresía) puede crear su organización
-- y leerla de vuelta (createOrganization), pero no ve ninguna otra.
set local role authenticated;
select set_config('request.jwt.claim.sub', '5ec00000-0000-4000-8000-0000000000c1', true),
       set_config('request.jwt.claims', '{"sub":"5ec00000-0000-4000-8000-0000000000c1","role":"authenticated","email":"creator-c@example.test"}', true);
do $$
declare v_id uuid;
begin
  assert (select count(*) from organizations) = 0, 'H2-6 un usuario sin membresía ve organizaciones';
  insert into organizations (name, slug, created_by)
  values ('Sec Org C', 'sec-org-c-91f2', '5ec00000-0000-4000-8000-0000000000c1') returning id into v_id;
  assert (select count(*) from organizations where id = v_id) = 1, 'H2-6 el creador no puede leer su organización';
  insert into organization_members (organization_id, user_id, role) values (v_id, '5ec00000-0000-4000-8000-0000000000c1', 'owner');
  assert (select count(*) from organizations) = 1, 'H2-6 el creador ve organizaciones ajenas';
end $$;

-- H2-7: el aprovisionamiento real del primer acceso sigue funcionando.
do $$
declare v record;
begin
  select * into v from public.bootstrap_personal_organization();
  assert v.organization_id is not null and v.created = false, 'H2-7 bootstrap no devolvió la organización existente';
end $$;
reset role;

select 'TODAS LAS PRUEBAS DE SEGURIDAD H1/H2 PASARON' as resultado;

rollback;
