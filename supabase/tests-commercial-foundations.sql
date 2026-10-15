-- Pruebas de migrations-commercial-foundations.sql. SOLO para un Postgres
-- DESECHABLE. Una transacción con ROLLBACK; cada bloque usa `assert`.
-- Límites y presupuestos de prueba FICTICIOS (no son una propuesta comercial).

begin;

insert into auth.users (id, email) values
  ('c0000000-0000-4000-8000-0000000000a1', 'owner-a@example.test'),
  ('c0000000-0000-4000-8000-0000000000a2', 'member-a@example.test'),
  ('c0000000-0000-4000-8000-0000000000b1', 'owner-b@example.test');
insert into organizations (id, name, slug) values
  ('c0000000-0000-4000-8000-00000000000a', 'Com Org A', 'com-org-a-77d1'),
  ('c0000000-0000-4000-8000-00000000000b', 'Com Org B', 'com-org-b-77d1');
insert into organization_members (organization_id, user_id, role) values
  ('c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000a1', 'owner'),
  ('c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000a2', 'member'),
  ('c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000b1', 'owner');

-- Plan de prueba con límites (los reales siguen en NULL).
insert into plans (code, display_name, monthly_conversation_limit, monthly_budget_micros)
values ('test_plan_77d1', 'Plan de prueba', 100, 10000000);

-- C-1: solo service_role puede asignar planes; nadie puede leer el historial.
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    assert not has_function_privilege(v_role, 'public.assign_organization_plan(uuid, text, text, text, text, text)', 'execute'), 'C-1 ' || v_role || ' asigna planes';
    assert not has_table_privilege(v_role, 'public.plan_assignments', 'select'), 'C-1 ' || v_role || ' lee el historial';
  end loop;
  assert not has_function_privilege('anon', 'public.get_my_organization_usage(uuid)', 'execute'), 'C-1 anon consulta consumo';
end $$;

-- C-2: no se puede pasar a enforce con límites sin configurar (los planes reales).
do $$
declare v_failed boolean := false;
begin
  begin
    perform public.assign_organization_plan('c0000000-0000-4000-8000-00000000000a', 'starter', 'enforce', 'Pago manual de prueba', 'operador@maastac.test');
  exception when others then v_failed := sqlerrm = 'PLAN_LIMITS_NOT_CONFIGURED';
  end;
  assert v_failed, 'C-2 enforce aceptado con límites NULL';
  assert (select enforcement_mode from organization_quotas where organization_id = 'c0000000-0000-4000-8000-00000000000a') = 'shadow', 'C-2 el modo cambió pese al error';
  assert not exists (select 1 from plan_assignments where organization_id = 'c0000000-0000-4000-8000-00000000000a'), 'C-2 auditoría de un cambio fallido';
end $$;

-- C-3: validaciones de entrada (plan inexistente, modo inválido, auditoría vacía).
do $$
declare v_case record; v_error text;
begin
  for v_case in select * from (values
      ('no_existe', 'shadow', 'Motivo válido', 'operador', 'PLAN_NOT_FOUND'),
      ('test_plan_77d1', 'gratis', 'Motivo válido', 'operador', 'PLAN_INVALID_MODE'),
      ('test_plan_77d1', 'shadow', '', 'operador', 'PLAN_AUDIT_FIELDS_REQUIRED'),
      ('test_plan_77d1', 'shadow', 'Motivo válido', ' ', 'PLAN_AUDIT_FIELDS_REQUIRED')
    ) as t(plan, mode, reason, who, expected)
  loop
    v_error := null;
    begin
      perform public.assign_organization_plan('c0000000-0000-4000-8000-00000000000a', v_case.plan, v_case.mode, v_case.reason, v_case.who);
    exception when others then v_error := sqlerrm;
    end;
    assert v_error = v_case.expected, 'C-3 esperaba ' || v_case.expected || ', obtuvo ' || coalesce(v_error, 'éxito');
  end loop;
end $$;

-- C-4: asignación correcta → plan, modo y auditoría; los contadores no se tocan.
do $$
declare v jsonb;
begin
  insert into usage_periods (organization_id, period_start, conversations_used, messages_used, settled_micros, reserved_micros)
  values ('c0000000-0000-4000-8000-00000000000a', date_trunc('month', (now() at time zone 'utc'))::date, 25, 140, 2000000, 500000);
  v := public.assign_organization_plan('c0000000-0000-4000-8000-00000000000a', 'test_plan_77d1', 'enforce', 'Transferencia recibida', 'operador@maastac.test', 'TRF-0001');
  assert v ->> 'plan' = 'test_plan_77d1' and v ->> 'mode' = 'enforce' and v ->> 'previous_mode' = 'shadow', 'C-4 resultado incorrecto';
  assert (select plan_code = 'test_plan_77d1' and enforcement_mode = 'enforce' from organization_quotas where organization_id = 'c0000000-0000-4000-8000-00000000000a'), 'C-4 cuota no actualizada';
  assert (select count(*) = 1 and bool_and(payment_reference = 'TRF-0001' and previous_plan_code = 'pilot' and assigned_by = 'operador@maastac.test')
          from plan_assignments where organization_id = 'c0000000-0000-4000-8000-00000000000a'), 'C-4 auditoría incorrecta';
  assert (select conversations_used = 25 and settled_micros = 2000000 from usage_periods where organization_id = 'c0000000-0000-4000-8000-00000000000a'), 'C-4 tocó los contadores';
end $$;

-- C-5: el owner ve su consumo (porcentaje, sin importes).
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c0000000-0000-4000-8000-0000000000a1', true),
       set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
do $$
declare v record; v_json jsonb;
begin
  select * into v from public.get_my_organization_usage('c0000000-0000-4000-8000-00000000000a');
  assert v.plan_name = 'Plan de prueba' and v.conversations_used = 25 and v.conversation_limit = 100 and v.messages_used = 140, 'C-5 datos incorrectos';
  assert v.budget_used_percent = 25 and v.limits_configured and v.status = 'active', 'C-5 porcentaje incorrecto (esperado 25)';
  select to_jsonb(u) into v_json from public.get_my_organization_usage('c0000000-0000-4000-8000-00000000000a') u;
  assert v_json::text not like '%micros%' and v_json::text not like '%2000000%', 'C-5 expone importes';
end $$;

-- C-6: el owner de A NO ve el consumo de B.
do $$
declare v_error text;
begin
  begin
    perform * from public.get_my_organization_usage('c0000000-0000-4000-8000-00000000000b');
  exception when others then v_error := sqlerrm;
  end;
  assert v_error = 'NOT_ADMIN', 'C-6 el owner de A leyó B: ' || coalesce(v_error, 'sin error');
end $$;
reset role;

-- C-7: un miembro (no admin) no ve el consumo de su propia organización.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c0000000-0000-4000-8000-0000000000a2', true),
       set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
do $$
declare v_error text;
begin
  begin
    perform * from public.get_my_organization_usage('c0000000-0000-4000-8000-00000000000a');
  exception when others then v_error := sqlerrm;
  end;
  assert v_error = 'NOT_ADMIN', 'C-7 un member leyó el consumo';
end $$;
reset role;

-- C-8: organización sin límites configurados → se informa, sin dividir por cero.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c0000000-0000-4000-8000-0000000000b1', true),
       set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
do $$
declare v record;
begin
  select * into v from public.get_my_organization_usage('c0000000-0000-4000-8000-00000000000b');
  assert not v.limits_configured and v.budget_used_percent is null and v.conversations_used = 0, 'C-8 organización sin límites mal informada';
end $$;
reset role;

select 'TODAS LAS PRUEBAS DE CIMIENTOS COMERCIALES PASARON' as resultado;

rollback;
