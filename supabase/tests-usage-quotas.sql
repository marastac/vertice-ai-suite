-- Pruebas funcionales de migrations-usage-quotas.sql (Fase 1 de cuotas).
--
-- Pensado para un proyecto de STAGING o un Postgres desechable, nunca para
-- producción. Todo corre dentro de una transacción que termina en ROLLBACK:
-- crea sus propias organizaciones de prueba y no deja ningún rastro.
-- Cada bloque usa `assert`: si una comprobación falla, el script se detiene
-- con el mensaje correspondiente (y el ROLLBACK final no llega a ejecutarse,
-- pero la transacción abortada tampoco confirma nada).
--
-- Los precios de 'test-model-quota' son FICTICIOS (1 y 2 micro-USD por
-- token) y existen solo dentro de esta transacción — no son tarifas reales.
--
-- La prueba de CONCURRENCIA (dos conexiones simultáneas) no cabe en un único
-- script; ver el procedimiento manual al final de este archivo.

begin;

-- ── preparación ────────────────────────────────────────────────────────────
insert into public.organizations (id, name, slug) values
  ('f0000000-0000-4000-8000-00000000000a', 'Quota Test A', 'quota-test-a-7f3c'),
  ('f0000000-0000-4000-8000-00000000000b', 'Quota Test B', 'quota-test-b-7f3c'),
  ('f0000000-0000-4000-8000-00000000000c', 'Quota Test C', 'quota-test-c-7f3c');

-- ── T0: el trigger dio a cada organización nueva su fila en 'shadow' ──────
do $$
begin
  assert (select count(*) from public.organization_quotas
          where organization_id in ('f0000000-0000-4000-8000-00000000000a',
                                    'f0000000-0000-4000-8000-00000000000b',
                                    'f0000000-0000-4000-8000-00000000000c')
            and enforcement_mode = 'shadow' and plan_code = 'pilot' and status = 'active') = 3,
         'T0 el trigger no creó las tres cuotas en shadow';
end $$;

-- Las pruebas siguientes necesitan estados concretos: se borran las filas
-- automáticas y se fijan a mano. A y B con fila 'off'; C SIN fila (caso
-- 'unconfigured', p. ej. si el trigger hubiera fallado).
delete from public.organization_quotas
where organization_id in ('f0000000-0000-4000-8000-00000000000a',
                          'f0000000-0000-4000-8000-00000000000b',
                          'f0000000-0000-4000-8000-00000000000c');

insert into public.organization_quotas (organization_id, plan_code, enforcement_mode) values
  ('f0000000-0000-4000-8000-00000000000a', 'pilot', 'off'),
  ('f0000000-0000-4000-8000-00000000000b', 'pilot', 'off');

-- source_url/verified_on son obligatorios: la URL apunta a la página oficial
-- solo para cumplir la restricción; los valores siguen siendo FICTICIOS.
insert into public.model_prices (model, input_micros_per_mtok, output_micros_per_mtok, source_url, verified_on)
values ('test-model-quota', 1000000, 2000000, 'https://platform.claude.com/docs/en/about-claude/pricing', current_date);

-- ── T1: modo 'off' → permitido sin escribir nada ──────────────────────────
do $$
declare r jsonb;
begin
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000001', 'test-model-quota', 10, 10);
  assert (r->>'allowed')::boolean and r->>'mode' = 'off' and r->'reservation_id' = 'null'::jsonb, 'T1 off: ' || r::text;
  assert not exists (select 1 from public.usage_reservations where organization_id = 'f0000000-0000-4000-8000-00000000000a'), 'T1 off escribió reservas';
  assert not exists (select 1 from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a'), 'T1 off escribió periodos';
end $$;

-- ── T2: sin fila → 'unconfigured', DENEGADO sin escribir (nunca ilimitado) ─
do $$
declare r jsonb;
begin
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-00000000000c',
                                 'c0000000-0000-4000-8000-000000000002', 'test-model-quota', 10, 10);
  assert not (r->>'allowed')::boolean and r->>'mode' = 'unconfigured' and r->>'reason' = 'quota_not_configured'
         and r->'reservation_id' = 'null'::jsonb, 'T2 unconfigured: ' || r::text;
  assert not exists (select 1 from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000c'), 'T2 escribió periodos';
  assert not exists (select 1 from public.usage_reservations where organization_id = 'f0000000-0000-4000-8000-00000000000c'), 'T2 escribió reservas';
  assert (public.get_organization_quota_status('f0000000-0000-4000-8000-00000000000c'))->>'mode' = 'unconfigured', 'T2 status';
end $$;

-- A en 'enforce': 2 conversaciones, presupuesto de 100 micro-USD.
update public.organization_quotas
set enforcement_mode = 'enforce', conversation_limit_override = 2, budget_micros_override = 100
where organization_id = 'f0000000-0000-4000-8000-00000000000a';

-- ── T3: reserva permitida (estimación 10*1 + 10*2 = 30) ───────────────────
do $$
declare r jsonb; p public.usage_periods%rowtype;
begin
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 10, 10);
  assert (r->>'allowed')::boolean and r->>'mode' = 'enforce' and r->>'reservation_id' is not null
         and not (r->>'replayed')::boolean, 'T3: ' || r::text;
  select * into p from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  assert p.conversations_used = 1 and p.messages_used = 1 and p.reserved_micros = 30 and p.settled_micros = 0, 'T3 contadores';
end $$;

-- ── T4: idempotencia de la reserva (mismo request_id) ─────────────────────
do $$
declare r1 jsonb; r2 jsonb; p public.usage_periods%rowtype;
begin
  select jsonb_build_object('id', id) into r1 from public.usage_reservations
  where request_id = 'a0000000-0000-4000-8000-000000000003';
  r2 := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-00000000000a',
                                  'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 999, 999);
  assert (r2->>'replayed')::boolean and r2->>'reservation_id' = r1->>'id', 'T4 replay: ' || r2::text;
  select * into p from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  assert p.messages_used = 1 and p.reserved_micros = 30, 'T4 duplicó cargos';
  assert (select count(*) from public.usage_reservations where request_id = 'a0000000-0000-4000-8000-000000000003') = 1, 'T4 filas';
end $$;

-- ── T5: request_id reutilizado para otra organización → excepción ────────
do $$
begin
  begin
    perform public.reserve_chat_usage('a0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-00000000000b',
                                      'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 1, 1);
    assert false, 'T5 debía lanzar QUOTA_REQUEST_ID_CONFLICT';
  exception when raise_exception then
    assert sqlerrm = 'QUOTA_REQUEST_ID_CONFLICT', 'T5 mensaje: ' || sqlerrm;
  end;
end $$;

-- ── T6: segunda reserva (40*1 + 10*2 = 60) → total reservado 90 ───────────
do $$
declare r jsonb;
begin
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000006', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 40, 10);
  assert (r->>'allowed')::boolean, 'T6: ' || r::text;
end $$;

-- ── T7: ATOMICIDAD — denegación por presupuesto no escribe NADA ───────────
-- Sesión nueva (c...07): pasaría el límite de conversaciones (1 < 2) pero
-- 90 + 20 > 100. No debe contar la conversación, ni mensajes, ni reserva.
do $$
declare r jsonb; p public.usage_periods%rowtype;
begin
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000007', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000007', 'test-model-quota', 0, 10);
  assert not (r->>'allowed')::boolean and r->>'reason' = 'budget_exhausted', 'T7: ' || r::text;
  select * into p from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  assert p.conversations_used = 1 and p.messages_used = 2 and p.reserved_micros = 90 and p.settled_micros = 0, 'T7 contadores cambiaron';
  assert not exists (select 1 from public.usage_reservations where request_id = 'a0000000-0000-4000-8000-000000000007'), 'T7 creó reserva';
  assert not exists (select 1 from public.usage_conversations where session_id = 'c0000000-0000-4000-8000-000000000007'), 'T7 contó conversación';
end $$;

-- ── T8: liquidación real (5*1 + 5*2 = 15) e idempotencia ──────────────────
do $$
declare v_id uuid; r jsonb; r2 jsonb; p public.usage_periods%rowtype;
begin
  select id into v_id from public.usage_reservations where request_id = 'a0000000-0000-4000-8000-000000000003';
  r := public.settle_chat_usage(v_id, 5, 5, 'test-model-quota');
  assert (r->>'actual_micros')::bigint = 15 and r->>'basis' = 'actual' and not (r->>'replayed')::boolean, 'T8: ' || r::text;
  r2 := public.settle_chat_usage(v_id, 1000, 1000, 'test-model-quota');
  assert (r2->>'replayed')::boolean and (r2->>'actual_micros')::bigint = 15, 'T8 replay: ' || r2::text;
  select * into p from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  assert p.reserved_micros = 60 and p.settled_micros = 15, 'T8 contadores: reserved=' || p.reserved_micros || ' settled=' || p.settled_micros;
end $$;

-- ── T9: liquidación con uso desconocido → conserva la estimación (60) ─────
do $$
declare v_id uuid; r jsonb; p public.usage_periods%rowtype;
begin
  select id into v_id from public.usage_reservations where request_id = 'a0000000-0000-4000-8000-000000000006';
  r := public.settle_chat_usage(v_id, null, null, null);
  assert (r->>'actual_micros')::bigint = 60 and r->>'basis' = 'estimated', 'T9: ' || r::text;
  select * into p from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  assert p.reserved_micros = 0 and p.settled_micros = 75, 'T9 contadores';
end $$;

-- ── T10: límite de conversaciones; una conversación existente continúa ────
update public.organization_quotas set budget_micros_override = 1000000
where organization_id = 'f0000000-0000-4000-8000-00000000000a';

do $$
declare r jsonb;
begin
  -- 2.ª conversación: permitida.
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000010', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000010', 'test-model-quota', 1, 1);
  assert (r->>'allowed')::boolean, 'T10 segunda conversación: ' || r::text;
  -- 3.ª conversación: denegada.
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000011', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000011', 'test-model-quota', 1, 1);
  assert not (r->>'allowed')::boolean and r->>'reason' = 'conversation_limit_reached', 'T10 tercera: ' || r::text;
  -- Conversación ya contada: puede seguir enviando mensajes.
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000012', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 1, 1);
  assert (r->>'allowed')::boolean, 'T10 existente: ' || r::text;
  assert (select conversations_used from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a') = 2, 'T10 conteo';
end $$;

-- ── T11: AISLAMIENTO — A agotada no afecta a B ────────────────────────────
update public.organization_quotas
set enforcement_mode = 'enforce', conversation_limit_override = 5, budget_micros_override = 50
where organization_id = 'f0000000-0000-4000-8000-00000000000b';

do $$
declare r jsonb; a_before public.usage_periods%rowtype; a_after public.usage_periods%rowtype;
begin
  select * into a_before from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  -- A sigue denegando conversaciones nuevas...
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000013', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000013', 'test-model-quota', 1, 1);
  assert not (r->>'allowed')::boolean, 'T11 A debía denegar';
  -- ...mientras B (sin consumo propio) sí puede.
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000014', 'f0000000-0000-4000-8000-00000000000b',
                                 'c0000000-0000-4000-8000-000000000014', 'test-model-quota', 10, 10);
  assert (r->>'allowed')::boolean, 'T11 B: ' || r::text;
  select * into a_after from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  assert a_after.messages_used = a_before.messages_used and a_after.reserved_micros = a_before.reserved_micros
         and a_after.settled_micros = a_before.settled_micros, 'T11 B alteró contadores de A';
  assert (select conversations_used from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000b') = 1, 'T11 B contador';
end $$;

-- ── T12: suspendida, límites sin configurar, precio faltante ──────────────
do $$
declare r jsonb;
begin
  update public.organization_quotas set status = 'suspended' where organization_id = 'f0000000-0000-4000-8000-00000000000b';
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000015', 'f0000000-0000-4000-8000-00000000000b',
                                 'c0000000-0000-4000-8000-000000000014', 'test-model-quota', 1, 1);
  assert not (r->>'allowed')::boolean and r->>'reason' = 'suspended', 'T12 suspended: ' || r::text;

  update public.organization_quotas
  set status = 'active', conversation_limit_override = null, budget_micros_override = null
  where organization_id = 'f0000000-0000-4000-8000-00000000000b';
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000016', 'f0000000-0000-4000-8000-00000000000b',
                                 'c0000000-0000-4000-8000-000000000014', 'test-model-quota', 1, 1);
  assert not (r->>'allowed')::boolean and r->>'reason' = 'limit_not_configured', 'T12 sin límites: ' || r::text;

  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000017', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000003', 'modelo-sin-precio', 1, 1);
  assert not (r->>'allowed')::boolean and r->>'reason' = 'model_price_missing', 'T12 sin precio: ' || r::text;
  assert not exists (select 1 from public.usage_reservations
                     where request_id in ('a0000000-0000-4000-8000-000000000015', 'a0000000-0000-4000-8000-000000000016',
                                          'a0000000-0000-4000-8000-000000000017')), 'T12 denegaciones escribieron reservas';
end $$;

-- ── T13: tope por hora ────────────────────────────────────────────────────
do $$
declare r jsonb; v_recent integer;
begin
  select count(*) into v_recent from public.usage_reservations
  where organization_id = 'f0000000-0000-4000-8000-00000000000a' and created_at > now() - interval '1 hour';
  update public.organization_quotas set hourly_message_cap_override = v_recent
  where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000018', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 1, 1);
  assert not (r->>'allowed')::boolean and r->>'reason' = 'hourly_cap_reached', 'T13: ' || r::text;
  update public.organization_quotas set hourly_message_cap_override = null
  where organization_id = 'f0000000-0000-4000-8000-00000000000a';
end $$;

-- ── T14: modo 'shadow' nunca bloquea y registra el motivo ─────────────────
do $$
declare r jsonb;
begin
  update public.organization_quotas set enforcement_mode = 'shadow', budget_micros_override = 1
  where organization_id = 'f0000000-0000-4000-8000-00000000000a';
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000019', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 1, 1);
  assert (r->>'allowed')::boolean and r->>'mode' = 'shadow' and r->>'reason' = 'budget_exhausted'
         and r->>'reservation_id' is not null, 'T14: ' || r::text;
  assert (select shadow_would_deny from public.usage_reservations where request_id = 'a0000000-0000-4000-8000-000000000019')
         = 'budget_exhausted', 'T14 motivo no registrado';
  update public.organization_quotas set enforcement_mode = 'enforce', budget_micros_override = 1000000
  where organization_id = 'f0000000-0000-4000-8000-00000000000a';
end $$;

-- ── T15: CAMBIO DE MES — la liquidación va al periodo de la reserva ───────
-- Se simula una reserva hecha el mes anterior moviendo su period_start.
do $$
declare
  v_now date := date_trunc('month', now() at time zone 'utc')::date;
  v_prev date := (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date;
  v_id uuid; r jsonb; v_est bigint;
  cur_before public.usage_periods%rowtype; cur_after public.usage_periods%rowtype; prev public.usage_periods%rowtype;
begin
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000020', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 10, 0);
  v_id := (r->>'reservation_id')::uuid;
  select estimated_micros into v_est from public.usage_reservations where id = v_id;
  -- Trasladar la reserva y su parte de reserved_micros al mes anterior.
  update public.usage_reservations set period_start = v_prev where id = v_id;
  update public.usage_periods set reserved_micros = reserved_micros - v_est
  where organization_id = 'f0000000-0000-4000-8000-00000000000a' and period_start = v_now;
  insert into public.usage_periods (organization_id, period_start, reserved_micros)
  values ('f0000000-0000-4000-8000-00000000000a', v_prev, v_est);

  select * into cur_before from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a' and period_start = v_now;
  r := public.settle_chat_usage(v_id, 3, 0, 'test-model-quota');
  select * into cur_after from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a' and period_start = v_now;
  select * into prev from public.usage_periods where organization_id = 'f0000000-0000-4000-8000-00000000000a' and period_start = v_prev;

  assert prev.reserved_micros = 0 and prev.settled_micros = 3, 'T15 mes anterior: ' || row_to_json(prev)::text;
  assert cur_after.settled_micros = cur_before.settled_micros and cur_after.reserved_micros = cur_before.reserved_micros,
         'T15 la liquidación tocó el mes actual';
end $$;

-- ── T16: modelo informado distinto y sin precio → 'reservation_price' ─────
do $$
declare r jsonb; v_id uuid;
begin
  r := public.reserve_chat_usage('a0000000-0000-4000-8000-000000000021', 'f0000000-0000-4000-8000-00000000000a',
                                 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 100, 0);
  v_id := (r->>'reservation_id')::uuid;
  -- 10 tokens reales a precio de reserva = 10, pero se toma el mayor con la estimación (100).
  r := public.settle_chat_usage(v_id, 10, 0, 'otro-modelo-sin-precio');
  assert r->>'basis' = 'reservation_price' and (r->>'actual_micros')::bigint = 100, 'T16: ' || r::text;
end $$;

-- ── T17: argumentos inválidos → excepción sin escrituras ──────────────────
do $$
declare v_count bigint;
begin
  select count(*) into v_count from public.usage_reservations;
  begin
    perform public.reserve_chat_usage(null, 'f0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', 1, 1);
    assert false, 'T17 request_id null';
  exception when raise_exception then assert sqlerrm = 'QUOTA_INVALID_ARGUMENT', sqlerrm; end;
  begin
    perform public.reserve_chat_usage(gen_random_uuid(), 'f0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000000003', 'test-model-quota', -1, 1);
    assert false, 'T17 tokens negativos';
  exception when raise_exception then assert sqlerrm = 'QUOTA_INVALID_ARGUMENT', sqlerrm; end;
  begin
    perform public.settle_chat_usage(gen_random_uuid(), 1, 1, 'test-model-quota');
    assert false, 'T17 reserva inexistente';
  exception when raise_exception then assert sqlerrm = 'QUOTA_RESERVATION_NOT_FOUND', sqlerrm; end;
  begin
    perform public.settle_chat_usage((select id from public.usage_reservations limit 1), 1, null, null);
    assert false, 'T17 tokens a medias';
  exception when raise_exception then assert sqlerrm = 'QUOTA_INVALID_ARGUMENT', sqlerrm; end;
  assert (select count(*) from public.usage_reservations) = v_count, 'T17 escribió algo';
end $$;

-- ── T18: SEGURIDAD — anon y authenticated no pueden ejecutar ni leer ──────
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', v_role);
    begin
      perform public.reserve_chat_usage(gen_random_uuid(), 'f0000000-0000-4000-8000-00000000000b',
                                        gen_random_uuid(), 'test-model-quota', 1, 1);
      reset role;
      assert false, 'T18 ' || v_role || ' pudo ejecutar reserve_chat_usage';
    exception when insufficient_privilege then null;
    end;
    begin
      perform 1 from public.organization_quotas limit 1;
      reset role;
      assert false, 'T18 ' || v_role || ' pudo leer organization_quotas';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.organization_quotas set budget_micros_override = 999999999;
      reset role;
      assert false, 'T18 ' || v_role || ' pudo modificar organization_quotas';
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
end $$;

-- ── T19: cuota automática al crear una organización como usuario real ─────
-- Reproduce el alta automática (OrganizationProvider.tsx): rol
-- authenticated, RLS de organizations activa, sin ningún privilegio sobre
-- organization_quotas. El trigger (SECURITY DEFINER) debe crear la fila en
-- 'shadow' igualmente, sin sobrescribir las filas explícitas existentes.
do $$
declare
  v_user uuid := 'e0000000-0000-4000-8000-000000000019';
  v_org uuid := 'f0000000-0000-4000-8000-000000000019';
  v_row public.organization_quotas%rowtype;
  v_a_mode text;
begin
  select enforcement_mode into v_a_mode from public.organization_quotas
  where organization_id = 'f0000000-0000-4000-8000-00000000000a';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  insert into public.organizations (id, name, slug, created_by)
  values (v_org, 'Quota Test T19', 'quota-test-t19-7f3c', v_user);
  -- authenticated sigue sin poder leer cuotas (el trigger no abre nada).
  begin
    perform 1 from public.organization_quotas limit 1;
    reset role;
    assert false, 'T19 authenticated pudo leer organization_quotas';
  exception when insufficient_privilege then null;
  end;
  reset role;

  select * into v_row from public.organization_quotas where organization_id = v_org;
  assert found, 'T19 el trigger no creó la cuota para una organización creada por authenticated';
  assert v_row.enforcement_mode = 'shadow' and v_row.plan_code = 'pilot' and v_row.status = 'active'
         and v_row.conversation_limit_override is null and v_row.budget_micros_override is null
         and v_row.hourly_message_cap_override is null, 'T19 fila inesperada: ' || row_to_json(v_row)::text;

  -- Las filas configuradas explícitamente no cambian (A sigue en su modo).
  assert (select enforcement_mode from public.organization_quotas
          where organization_id = 'f0000000-0000-4000-8000-00000000000a') = v_a_mode, 'T19 modificó otra organización';

  -- Una organización 'shadow' recién creada nunca bloquea: reserva con motivo
  -- "habría denegado" (límites del plan sin configurar).
  assert (public.reserve_chat_usage(gen_random_uuid(), v_org, gen_random_uuid(), 'test-model-quota', 1, 1)->>'allowed')::boolean,
         'T19 una organización nueva en shadow fue bloqueada';

  -- Una organización con fila EXPLÍCITA en 'off' sigue sin efecto alguno.
  update public.organization_quotas set enforcement_mode = 'off' where organization_id = v_org;
  assert (public.reserve_chat_usage(gen_random_uuid(), v_org, gen_random_uuid(), 'test-model-quota', 1, 1)->>'mode') = 'off',
         'T19 off explícito dejó de funcionar';

  -- Nadie salvo el dueño puede ejecutar la función del trigger.
  assert not has_function_privilege('anon', 'public.create_default_organization_quota()', 'execute')
     and not has_function_privilege('authenticated', 'public.create_default_organization_quota()', 'execute')
     and not has_function_privilege('public', 'public.create_default_organization_quota()', 'execute'),
         'T19 la función del trigger es ejecutable por anon/authenticated/public';
  assert (select prosecdef from pg_proc where proname = 'create_default_organization_quota'
          and pronamespace = 'public'::regnamespace), 'T19 la función no es SECURITY DEFINER';
end $$;

-- ══ Conciliación de reservas abandonadas (riesgo 2) ═══════════════════════
-- Toda esta transacción comparte un único now(); una reserva solo cuenta
-- como "abandonada" si su created_at se retrocede a propósito (> 15 min).
-- Organizaciones propias (D…I) para no depender del estado de T1–T19.
create temp table r2_ids (name text primary key, id uuid not null) on commit drop;

insert into public.organizations (id, name, slug) values
  ('f0000000-0000-4000-8000-00000000000d', 'Quota Test D', 'quota-test-d-7f3c'),
  ('f0000000-0000-4000-8000-00000000000e', 'Quota Test E', 'quota-test-e-7f3c'),
  ('f0000000-0000-4000-8000-0000000000f1', 'Quota Test F', 'quota-test-f-7f3c'),
  ('f0000000-0000-4000-8000-0000000000f2', 'Quota Test G', 'quota-test-g-7f3c'),
  ('f0000000-0000-4000-8000-0000000000f3', 'Quota Test H1', 'quota-test-h1-7f3c'),
  ('f0000000-0000-4000-8000-0000000000f4', 'Quota Test H2', 'quota-test-h2-7f3c');

-- D y E en 'enforce' con margen amplio; las demás quedan en 'shadow' (trigger).
update public.organization_quotas
set enforcement_mode = 'enforce', conversation_limit_override = 100, budget_micros_override = 100000
where organization_id in ('f0000000-0000-4000-8000-00000000000d', 'f0000000-0000-4000-8000-00000000000e');

-- Preparación de D: r1 abandonada, r2 reciente, r3 abandonada pero ya
-- liquidada por el backend, r4 abandonada del MES ANTERIOR. 30 micros cada una.
do $$
declare
  v_org uuid := 'f0000000-0000-4000-8000-00000000000d';
  v_now date := date_trunc('month', now() at time zone 'utc')::date;
  v_prev date := (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date;
  v_name text;
  v_id uuid;
begin
  foreach v_name in array array['r1', 'r2', 'r3', 'r4'] loop
    v_id := (public.reserve_chat_usage(gen_random_uuid(), v_org, gen_random_uuid(), 'test-model-quota', 10, 10)->>'reservation_id')::uuid;
    assert v_id is not null, 'R2 prep: reserva no creada (' || v_name || ')';
    insert into r2_ids values (v_name, v_id);
  end loop;

  update public.usage_reservations set created_at = now() - interval '20 minutes'
  where id in (select id from r2_ids where name in ('r1', 'r3', 'r4'));

  perform public.settle_chat_usage((select id from r2_ids where name = 'r3'), 5, 5, 'test-model-quota');

  -- r4 pasa al mes anterior moviendo también su importe entre periodos,
  -- para mantener el invariante como lo habría dejado una reserva real.
  update public.usage_reservations set period_start = v_prev where id = (select id from r2_ids where name = 'r4');
  update public.usage_periods set reserved_micros = reserved_micros - 30
  where organization_id = v_org and period_start = v_now;
  insert into public.usage_periods (organization_id, period_start, conversations_used, messages_used, reserved_micros)
  values (v_org, v_prev, 0, 1, 30);
end $$;

-- ── E1/E2/E3/E6/E7: expira solo lo abandonado, por su estimación completa ──
do $$
declare
  v_org uuid := 'f0000000-0000-4000-8000-00000000000d';
  v_now date := date_trunc('month', now() at time zone 'utc')::date;
  v_prev date := (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date;
  r jsonb;
  cur_before public.usage_periods%rowtype;
  cur_after public.usage_periods%rowtype;
  prev_after public.usage_periods%rowtype;
  res public.usage_reservations%rowtype;
begin
  select * into cur_before from public.usage_periods where organization_id = v_org and period_start = v_now;

  r := public.expire_stale_chat_reservations();
  assert (r->>'expired_count')::int = 2 and (r->>'expired_micros')::bigint = 60
     and (r->>'organizations_processed')::int = 1 and (r->>'organizations_skipped_locked')::int = 0
     and (r->>'organizations_failed')::int = 0, 'E1 resultado: ' || r::text;

  -- E1: r1 cerrada por su estimación, nunca gratis.
  select * into res from public.usage_reservations where id = (select id from r2_ids where name = 'r1');
  assert res.status = 'settled' and res.settlement_basis = 'expired' and res.actual_micros = res.estimated_micros
     and res.actual_micros = 30 and res.settled_at is not null
     and res.actual_input_tokens is null and res.actual_output_tokens is null and res.actual_model is null,
     'E1 r1: ' || row_to_json(res)::text;

  -- E1: el presupuesto disponible del mes NO cambia (reserved → settled).
  select * into cur_after from public.usage_periods where organization_id = v_org and period_start = v_now;
  assert cur_after.reserved_micros = cur_before.reserved_micros - 30
     and cur_after.settled_micros = cur_before.settled_micros + 30
     and cur_after.reserved_micros + cur_after.settled_micros = cur_before.reserved_micros + cur_before.settled_micros,
     'E1 contadores del mes';

  -- E2: la reserva reciente sigue abierta.
  assert (select status from public.usage_reservations where id = (select id from r2_ids where name = 'r2')) = 'reserved', 'E2 r2 tocada';

  -- E3/E6: la ya liquidada por el backend conserva su liquidación real.
  select * into res from public.usage_reservations where id = (select id from r2_ids where name = 'r3');
  assert res.settlement_basis = 'actual' and res.actual_micros = 15, 'E3 r3: ' || row_to_json(res)::text;

  -- E7: la del mes anterior se aplica a SU periodo; el actual solo recibe r1.
  select * into res from public.usage_reservations where id = (select id from r2_ids where name = 'r4');
  assert res.settlement_basis = 'expired' and res.period_start = v_prev, 'E7 r4';
  select * into prev_after from public.usage_periods where organization_id = v_org and period_start = v_prev;
  assert prev_after.reserved_micros = 0 and prev_after.settled_micros = 30, 'E7 periodo anterior';
end $$;

-- ── E4: idempotencia — una segunda pasada no cambia nada ─────────────────
do $$
declare
  r jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  select jsonb_agg(to_jsonb(p) - 'updated_at' order by period_start) into v_before
  from public.usage_periods p where organization_id = 'f0000000-0000-4000-8000-00000000000d';

  r := public.expire_stale_chat_reservations();
  assert (r->>'expired_count')::int = 0 and (r->>'expired_micros')::bigint = 0, 'E4 segunda pasada: ' || r::text;

  select jsonb_agg(to_jsonb(p) - 'updated_at' order by period_start) into v_after
  from public.usage_periods p where organization_id = 'f0000000-0000-4000-8000-00000000000d';
  assert v_before = v_after, 'E4 contadores cambiaron';
end $$;

-- ── E5: una liquidación TARDÍA recibe la reserva ya expirada (replay) ─────
do $$
declare
  r jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  select jsonb_agg(to_jsonb(p) - 'updated_at' order by period_start) into v_before
  from public.usage_periods p where organization_id = 'f0000000-0000-4000-8000-00000000000d';

  r := public.settle_chat_usage((select id from r2_ids where name = 'r1'), 1, 1, 'test-model-quota');
  assert (r->>'replayed')::boolean and r->>'basis' = 'expired' and (r->>'actual_micros')::bigint = 30, 'E5: ' || r::text;

  select jsonb_agg(to_jsonb(p) - 'updated_at' order by period_start) into v_after
  from public.usage_periods p where organization_id = 'f0000000-0000-4000-8000-00000000000d';
  assert v_before = v_after, 'E5 la liquidación tardía cambió contadores';
end $$;

-- ── E8: aislamiento — expirar en E no altera D ────────────────────────────
do $$
declare
  v_e uuid := 'f0000000-0000-4000-8000-00000000000e';
  v_id uuid;
  v_d_before jsonb;
  v_d_after jsonb;
  r jsonb;
begin
  v_id := (public.reserve_chat_usage(gen_random_uuid(), v_e, gen_random_uuid(), 'test-model-quota', 10, 10)->>'reservation_id')::uuid;
  update public.usage_reservations set created_at = now() - interval '20 minutes' where id = v_id;

  select jsonb_agg(to_jsonb(x) order by x.id) into v_d_before
  from public.usage_reservations x where organization_id = 'f0000000-0000-4000-8000-00000000000d';

  r := public.expire_stale_chat_reservations();
  assert (r->>'expired_count')::int = 1 and (r->>'organizations_processed')::int = 1, 'E8: ' || r::text;
  assert (select settlement_basis from public.usage_reservations where id = v_id) = 'expired', 'E8 E no expiró';

  select jsonb_agg(to_jsonb(x) order by x.id) into v_d_after
  from public.usage_reservations x where organization_id = 'f0000000-0000-4000-8000-00000000000d';
  assert v_d_before = v_d_after, 'E8 tocó la organización D';
end $$;

-- ── E9/E10: sin fila de cuota se procesa; un periodo inexistente revierte
--            SOLO esa organización y las demás continúan ───────────────────
do $$
declare
  v_f uuid := 'f0000000-0000-4000-8000-0000000000f1';
  v_g uuid := 'f0000000-0000-4000-8000-0000000000f2';
  v_now date := date_trunc('month', now() at time zone 'utc')::date;
  v_f_id uuid;
  v_g_id uuid;
  r jsonb;
begin
  -- F y G están en 'shadow' (trigger): reservan y escriben igualmente.
  v_f_id := (public.reserve_chat_usage(gen_random_uuid(), v_f, gen_random_uuid(), 'test-model-quota', 10, 10)->>'reservation_id')::uuid;
  v_g_id := (public.reserve_chat_usage(gen_random_uuid(), v_g, gen_random_uuid(), 'test-model-quota', 10, 10)->>'reservation_id')::uuid;
  assert v_f_id is not null and v_g_id is not null, 'E9/E10 prep';
  update public.usage_reservations set created_at = now() - interval '20 minutes' where id in (v_f_id, v_g_id);

  delete from public.organization_quotas where organization_id = v_f;                -- E9
  delete from public.usage_periods where organization_id = v_g and period_start = v_now; -- E10

  r := public.expire_stale_chat_reservations();
  assert (r->>'expired_count')::int = 1 and (r->>'organizations_processed')::int = 1
     and (r->>'organizations_failed')::int = 1, 'E9/E10: ' || r::text;
  assert (select settlement_basis from public.usage_reservations where id = v_f_id) = 'expired', 'E9 F no expiró';
  assert (select status from public.usage_reservations where id = v_g_id) = 'reserved', 'E10 G no se revirtió';

  -- Limpieza de G para que no falle en las pasadas siguientes.
  delete from public.usage_reservations where id = v_g_id;
end $$;

-- ── E11: límite de organizaciones por llamada ────────────────────────────
do $$
declare
  v_h1 uuid := 'f0000000-0000-4000-8000-0000000000f3';
  v_h2 uuid := 'f0000000-0000-4000-8000-0000000000f4';
  v_id1 uuid;
  v_id2 uuid;
  r jsonb;
begin
  v_id1 := (public.reserve_chat_usage(gen_random_uuid(), v_h1, gen_random_uuid(), 'test-model-quota', 10, 10)->>'reservation_id')::uuid;
  v_id2 := (public.reserve_chat_usage(gen_random_uuid(), v_h2, gen_random_uuid(), 'test-model-quota', 10, 10)->>'reservation_id')::uuid;
  update public.usage_reservations set created_at = now() - interval '20 minutes' where id in (v_id1, v_id2);

  r := public.expire_stale_chat_reservations(interval '15 minutes', 1);
  assert (r->>'organizations_processed')::int = 1 and (r->>'expired_count')::int = 1, 'E11 primera: ' || r::text;
  -- Orden fijo por organization_id: H1 (…f3) antes que H2 (…f4).
  assert (select status from public.usage_reservations where id = v_id1) = 'settled'
     and (select status from public.usage_reservations where id = v_id2) = 'reserved', 'E11 orden';

  r := public.expire_stale_chat_reservations(interval '15 minutes', 1);
  assert (r->>'expired_count')::int = 1
     and (select status from public.usage_reservations where id = v_id2) = 'settled', 'E11 segunda: ' || r::text;
end $$;

-- ── E12: argumentos y seguridad ──────────────────────────────────────────
do $$
declare v_role text;
begin
  -- Nadie puede pedir una ventana menor a 15 min (expiraría reservas activas).
  begin
    perform public.expire_stale_chat_reservations(interval '14 minutes 59 seconds', 100);
    assert false, 'E12 aceptó una ventana menor a 15 min';
  exception when raise_exception then assert sqlerrm = 'QUOTA_INVALID_ARGUMENT', sqlerrm; end;
  begin
    perform public.expire_stale_chat_reservations(interval '15 minutes', 0);
    assert false, 'E12 aceptó p_max_organizations = 0';
  exception when raise_exception then assert sqlerrm = 'QUOTA_INVALID_ARGUMENT', sqlerrm; end;
  begin
    perform public.expire_stale_chat_reservations(null, 100);
    assert false, 'E12 aceptó una ventana NULL';
  exception when raise_exception then assert sqlerrm = 'QUOTA_INVALID_ARGUMENT', sqlerrm; end;

  foreach v_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', v_role);
    begin
      perform public.expire_stale_chat_reservations();
      reset role;
      assert false, 'E12 ' || v_role || ' pudo ejecutar expire_stale_chat_reservations';
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;

  assert not (select prosecdef from pg_proc where proname = 'expire_stale_chat_reservations'
              and pronamespace = 'public'::regnamespace), 'E12 la función no es SECURITY INVOKER';
end $$;

-- ── E13: invariante global — reserved_micros de cada periodo = suma de las
--         estimaciones de sus reservas abiertas (en TODAS las organizaciones) ─
do $$
declare v_bad integer;
begin
  select count(*) into v_bad
  from public.usage_periods p
  left join (
    select organization_id, period_start, sum(estimated_micros) as open_micros
    from public.usage_reservations where status = 'reserved'
    group by organization_id, period_start
  ) r on r.organization_id = p.organization_id and r.period_start = p.period_start
  where p.reserved_micros <> coalesce(r.open_micros, 0);
  assert v_bad = 0, 'E13 invariante roto en ' || v_bad || ' periodo(s)';
end $$;

-- ══ Precios e identificadores de modelos (riesgo 3) ═══════════════════════
-- Todos los modelos y precios de este bloque son FICTICIOS. La URL oficial
-- solo cumple la restricción de procedencia.

-- ── P1/P2/P3: restricciones de formato, rango y procedencia ──────────────
do $$
declare
  v_url constant text := 'https://platform.claude.com/docs/en/about-claude/pricing';
  v_bad record;
begin
  -- Filas inválidas: cada una debe ser rechazada por un CHECK (23514).
  for v_bad in
    select * from (values
      ('P1 mayúsculas',        'Test-Model-P',      5000000::bigint, 25000000::bigint, v_url, current_date),
      ('P1 espacio inicial',   ' test-model-p',     5000000, 25000000, v_url, current_date),
      ('P1 espacio interno',   'test model p',      5000000, 25000000, v_url, current_date),
      ('P2 precio en USD',     'test-model-p',      5,       25,       v_url, current_date),
      ('P2 cero',              'test-model-p',      0,       25000000, v_url, current_date),
      ('P2 demasiado alto',    'test-model-p',      5000000, 1000000001, v_url, current_date),
      ('P3 sin fuente',        'test-model-p',      5000000, 25000000, null,  current_date),
      ('P3 http',              'test-model-p',      5000000, 25000000, 'http://platform.claude.com/docs/en/about-claude/pricing', current_date),
      ('P3 otro dominio',      'test-model-p',      5000000, 25000000, 'https://example.com/pricing', current_date),
      ('P3 dominio parecido',  'test-model-p',      5000000, 25000000, 'https://evil-anthropic.com/pricing', current_date),
      ('P3 sufijo engañoso',   'test-model-p',      5000000, 25000000, 'https://anthropic.com.evil.example/pricing', current_date),
      ('P3 sin fecha',         'test-model-p',      5000000, 25000000, v_url, null)
    ) as t(label, model, p_in, p_out, src, verified)
  loop
    begin
      insert into public.model_prices (model, input_micros_per_mtok, output_micros_per_mtok, source_url, verified_on)
      values (v_bad.model, v_bad.p_in, v_bad.p_out, v_bad.src, v_bad.verified);
      assert false, v_bad.label || ': fila inválida aceptada';
    exception when check_violation then null;
    end;
  end loop;

  -- Filas válidas (incluye subdominio oficial y otro dominio de Anthropic).
  insert into public.model_prices (model, input_micros_per_mtok, output_micros_per_mtok, source_url, verified_on) values
    ('test-model-p', 5000000, 25000000, v_url, current_date),
    ('test-model-p-20990101', 5000000, 25000000, 'https://docs.anthropic.com/en/docs/about-claude/pricing', current_date),
    ('test-model-p-cheap', 1000000, 5000000, 'https://www.anthropic.com/pricing', current_date);
  assert (select count(*) from public.model_prices where model like 'test-model-p%') = 3, 'P2/P3 filas válidas rechazadas';
end $$;

-- Organización P en 'enforce' con margen amplio para P4–P8.
insert into public.organizations (id, name, slug)
values ('f0000000-0000-4000-8000-0000000000f5', 'Quota Test P', 'quota-test-p-7f3c');
update public.organization_quotas
set enforcement_mode = 'enforce', conversation_limit_override = 100, budget_micros_override = 1000000000
where organization_id = 'f0000000-0000-4000-8000-0000000000f5';

-- ── P4: precio congelado — cambiar la fila no altera una reserva abierta ──
do $$
declare
  v_org uuid := 'f0000000-0000-4000-8000-0000000000f5';
  v_id uuid;
  r jsonb;
begin
  v_id := (public.reserve_chat_usage(gen_random_uuid(), v_org, gen_random_uuid(), 'test-model-p', 1000000, 0)->>'reservation_id')::uuid;
  update public.model_prices set input_micros_per_mtok = 9000000 where model = 'test-model-p';
  r := public.settle_chat_usage(v_id, 1000000, 0, 'test-model-p');
  assert r->>'basis' = 'actual' and (r->>'actual_micros')::bigint = 5000000, 'P4 no usó el precio congelado: ' || r::text;
  update public.model_prices set input_micros_per_mtok = 5000000 where model = 'test-model-p';
end $$;

-- ── P5: modelo reportado distinto CON fila → 'actual' a SU precio ─────────
do $$
declare
  v_org uuid := 'f0000000-0000-4000-8000-0000000000f5';
  v_id uuid;
  r jsonb;
begin
  v_id := (public.reserve_chat_usage(gen_random_uuid(), v_org, gen_random_uuid(), 'test-model-p', 1000000, 0)->>'reservation_id')::uuid;
  r := public.settle_chat_usage(v_id, 1000000, 0, 'test-model-p-cheap');
  assert r->>'basis' = 'actual' and (r->>'actual_micros')::bigint = 1000000, 'P5: ' || r::text;
end $$;

-- ── P7: alias y versión con fecha cargados con el mismo precio → sin
--        sobrecobro (no cae en 'reservation_price') ────────────────────────
do $$
declare
  v_org uuid := 'f0000000-0000-4000-8000-0000000000f5';
  v_id uuid;
  r jsonb;
begin
  v_id := (public.reserve_chat_usage(gen_random_uuid(), v_org, gen_random_uuid(), 'test-model-p', 5000000, 1000000)->>'reservation_id')::uuid;
  r := public.settle_chat_usage(v_id, 1000, 100, 'test-model-p-20990101');
  -- (1000 × 5000000 + 100 × 25000000) / 1000000 = 7500 micros, muy por
  -- debajo de la estimación (50000000): se cobró el uso real, no la cota.
  assert r->>'basis' = 'actual' and (r->>'actual_micros')::bigint = 7500, 'P7: ' || r::text;
end $$;

-- ── P8: get_organization_quota_status con p_model ────────────────────────
do $$
declare
  v_org uuid := 'f0000000-0000-4000-8000-0000000000f5';
  r jsonb;
begin
  r := public.get_organization_quota_status(v_org, 'test-model-p');
  assert r->>'mode' = 'enforce' and (r->>'model_price_configured')::boolean, 'P8 con precio: ' || r::text;

  r := public.get_organization_quota_status(v_org, 'modelo-inexistente-p8');
  assert not (r->>'model_price_configured')::boolean, 'P8 sin precio: ' || r::text;

  r := public.get_organization_quota_status(v_org);
  assert not (r ? 'model_price_configured') and r->>'mode' = 'enforce', 'P8 sin p_model cambió la respuesta: ' || r::text;

  -- Organización sin fila de cuota: también informa el precio.
  r := public.get_organization_quota_status('f0000000-0000-4000-8000-00000000000c', 'test-model-p');
  assert r->>'mode' = 'unconfigured' and (r->>'model_price_configured')::boolean, 'P8 unconfigured: ' || r::text;

  -- Solo existe la firma nueva: una llamada con un argumento no es ambigua.
  assert (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
          and proname = 'get_organization_quota_status') = 1, 'P8 quedaron dos firmas';
end $$;

-- ── P9: consultas de vigilancia (mismas que monitoring-usage-quotas.sql) ──
do $$
declare v_org uuid := 'f0000000-0000-4000-8000-0000000000f5';
begin
  -- 'reservation_price' de T16 aparece en la consulta 3.
  assert exists (select 1 from public.usage_reservations
                 where settlement_basis = 'reservation_price' and actual_model = 'otro-modelo-sin-precio'),
         'P9 la consulta 3 no detecta reservation_price';
  -- Modelo distinto del reservado (P5) aparece en la consulta 4.
  assert exists (select 1 from public.usage_reservations
                 where actual_model is not null and actual_model <> model and actual_model = 'test-model-p-cheap'),
         'P9 la consulta 4 no detecta el modelo distinto';
  -- Un modelo reportado en usage_events sin fila de precio aparece en la consulta 2.
  insert into public.usage_events (organization_id, session_id, purpose, model, input_tokens, output_tokens)
  values (v_org, gen_random_uuid(), 'reply', 'modelo-reportado-sin-precio', 1, 1);
  assert exists (select 1 from public.usage_events e left join public.model_prices p on p.model = e.model
                 where p.model is null and e.model = 'modelo-reportado-sin-precio'),
         'P9 la consulta 2 no detecta el modelo sin precio';
  assert not exists (select 1 from public.usage_events e left join public.model_prices p on p.model = e.model
                     where p.model is null and e.model = 'test-model-p'),
         'P9 la consulta 2 marcó un modelo con precio';
end $$;

select 'TODAS LAS PRUEBAS DE CUOTAS PASARON' as resultado;

rollback;

-- ── Prueba manual de CONCURRENCIA (staging / Postgres desechable) ─────────
-- Objetivo: con presupuesto para UNA sola reserva, dos solicitudes
-- simultáneas de la misma organización → exactamente una permitida.
-- Requiere datos confirmados (no dentro de la transacción de arriba) y dos
-- conexiones abiertas a la vez (p. ej. dos pestañas de psql):
--
--   Preparación (confirmada): una organización de prueba con
--   enforcement_mode='enforce', conversation_limit_override=10,
--   budget_micros_override=30, y un model_prices de prueba (1/2 micros).
--
--   Conexión 1:  begin;
--                select public.reserve_chat_usage(gen_random_uuid(), '<org>', gen_random_uuid(), '<modelo>', 10, 10);
--                -- (no hacer commit todavía: mantiene el bloqueo de la organización)
--   Conexión 2:  select public.reserve_chat_usage(gen_random_uuid(), '<org>', gen_random_uuid(), '<modelo>', 10, 10);
--                -- queda ESPERANDO al bloqueo de la conexión 1
--   Conexión 1:  commit;
--   Conexión 2:  devuelve allowed=false, reason='budget_exhausted'.
--
--   Repetir con una SEGUNDA organización en la conexión 2 mientras la 1
--   mantiene su transacción abierta: debe responder al instante (sin
--   esperar), demostrando que organizaciones distintas no se bloquean.
--   Al terminar, eliminar las organizaciones de prueba (on delete cascade
--   limpia sus filas de cuotas y consumo).

-- ── Prueba manual E14: la conciliación SALTA organizaciones ocupadas ──────
--   Preparación (confirmada): dos organizaciones de prueba X e Y, cada una
--   con una reserva 'reserved' y created_at retrocedido 20 minutos.
--
--   Conexión 1:  begin;
--                select 1 from public.organization_quotas where organization_id = '<X>' for update;
--                -- (no hacer commit: simula a X atendiendo un mensaje)
--   Conexión 2:  select public.expire_stale_chat_reservations();
--                -- responde AL INSTANTE (no espera a la conexión 1):
--                -- organizations_skipped_locked = 1, Y expirada, X sigue 'reserved'.
--   Conexión 1:  commit;
--   Conexión 2:  select public.expire_stale_chat_reservations();
--                -- ahora expira X.
--
-- ── Prueba manual: lock_timeout de reserve/settle (2 s) ───────────────────
--   Conexión 1:  begin;
--                select 1 from public.organization_quotas where organization_id = '<X>' for update;
--   Conexión 2:  select public.reserve_chat_usage(gen_random_uuid(), '<X>', gen_random_uuid(), '<modelo>', 1, 1);
--                -- falla en ~2 s con "canceling statement due to lock
--                -- timeout" (SQLSTATE 55P03) y NO deja ninguna reserva.
--   Conexión 1:  rollback;
