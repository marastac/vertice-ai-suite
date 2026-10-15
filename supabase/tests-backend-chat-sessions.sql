-- Pruebas de migrations-backend-chat-sessions.sql (copia durable de las
-- sesiones de chat del backend). SOLO para un Postgres DESECHABLE. Una
-- transacción que termina en ROLLBACK; cada bloque usa `assert`.

begin;

insert into organizations (id, name, slug) values
  ('b5000000-0000-4000-8000-00000000000a', 'BS Org A', 'bs-org-a-41c9'),
  ('b5000000-0000-4000-8000-00000000000b', 'BS Org B', 'bs-org-b-41c9');

-- S-1: anon y authenticated no pueden leer, escribir ni ejecutar nada.
do $$
declare v_role text; v_ok boolean;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    assert not has_table_privilege(v_role, 'public.backend_chat_sessions', 'select'), 'S-1 ' || v_role || ' puede leer';
    assert not has_table_privilege(v_role, 'public.backend_chat_sessions', 'insert'), 'S-1 ' || v_role || ' puede insertar';
    assert not has_function_privilege(v_role, 'public.save_backend_chat_session(uuid, uuid, text, jsonb, bigint)', 'execute'), 'S-1 ' || v_role || ' ejecuta save';
    assert not has_function_privilege(v_role, 'public.list_recent_backend_chat_sessions(timestamptz, integer)', 'execute'), 'S-1 ' || v_role || ' ejecuta list';
  end loop;
  assert has_function_privilege('service_role', 'public.save_backend_chat_session(uuid, uuid, text, jsonb, bigint)', 'execute'), 'S-1 service_role sin save';
  assert (select relrowsecurity from pg_class where oid = 'public.backend_chat_sessions'::regclass), 'S-1 RLS desactivado';
  assert not exists (select 1 from pg_policies where tablename = 'backend_chat_sessions'), 'S-1 hay políticas RLS';
end $$;

-- S-1b: aunque alguien intentara leer como anon, la llamada se rechaza.
set local role anon;
do $$
begin
  begin
    perform 1 from public.backend_chat_sessions;
    assert false, 'S-1b anon leyó la tabla';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- S-2: guarda, aplica solo versiones más nuevas y nunca retrocede.
do $$
declare v_id uuid := 'b5000000-0000-4000-8000-0000000005a1';
begin
  assert public.save_backend_chat_session(v_id, null, 'bs-org-a-41c9', '{"id":"b5000000-0000-4000-8000-0000000005a1","history":[]}', 10), 'S-2 primera escritura';
  assert public.save_backend_chat_session(v_id, 'b5000000-0000-4000-8000-00000000000a', 'bs-org-a-41c9', '{"id":"x","history":[1,2]}', 20), 'S-2 versión nueva';
  assert not public.save_backend_chat_session(v_id, 'b5000000-0000-4000-8000-00000000000a', 'bs-org-a-41c9', '{"id":"x","history":[1]}', 15), 'S-2 se aplicó una versión VIEJA';
  assert not public.save_backend_chat_session(v_id, 'b5000000-0000-4000-8000-00000000000a', 'bs-org-a-41c9', '{"id":"x","history":[]}', 20), 'S-2 se aplicó la MISMA versión';
  assert (select version = 20 and jsonb_array_length(state -> 'history') = 2 from backend_chat_sessions where id = v_id), 'S-2 el estado retrocedió';
  -- NULL → organización: permitido (sesión que se resolvió después).
  assert (select organization_id = 'b5000000-0000-4000-8000-00000000000a' from backend_chat_sessions where id = v_id), 'S-2 no se atribuyó la organización';
end $$;

-- S-3: una sesión nunca cambia a OTRA organización (ni se "desatribuye").
do $$
declare v_id uuid := 'b5000000-0000-4000-8000-0000000005a1';
begin
  assert not public.save_backend_chat_session(v_id, 'b5000000-0000-4000-8000-00000000000b', 'bs-org-b-41c9', '{"id":"x","history":[9]}', 30), 'S-3 cambió de organización';
  assert (select organization_id = 'b5000000-0000-4000-8000-00000000000a' and version = 20 from backend_chat_sessions where id = v_id), 'S-3 fila alterada';
  assert public.save_backend_chat_session(v_id, null, 'bs-org-a-41c9', '{"id":"x","history":[1,2,3]}', 40), 'S-3 escritura sin organización rechazada';
  assert (select organization_id = 'b5000000-0000-4000-8000-00000000000a' from backend_chat_sessions where id = v_id), 'S-3 perdió la organización';
end $$;

-- S-4: argumentos inválidos y estado que no es un objeto.
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin perform public.save_backend_chat_session('b5000000-0000-4000-8000-0000000005a2', null, 'bs', '{}', 0);
  exception when others then v_failed := sqlerrm = 'BACKEND_SESSION_INVALID_ARGUMENT'; end;
  assert v_failed, 'S-4 versión 0 aceptada';
  v_failed := false;
  begin perform public.save_backend_chat_session('b5000000-0000-4000-8000-0000000005a3', null, 'bs', '[1,2]', 1);
  exception when check_violation then v_failed := true; end;
  assert v_failed, 'S-4 estado no-objeto aceptado';
end $$;

-- S-5: recuperación — solo recientes, más nuevas primero, con límite.
do $$
begin
  perform public.save_backend_chat_session(('b5000000-0000-4000-8000-0000000006' || lpad(i::text, 2, '0'))::uuid, null, 'bs-org-b-41c9', '{"id":"y","history":[]}', 1)
  from generate_series(1, 5) i;
  update backend_chat_sessions set updated_at = now() - interval '30 days' where id = 'b5000000-0000-4000-8000-000000000601';
  assert (select count(*) from public.list_recent_backend_chat_sessions(now() - interval '14 days', 5000)
          where id::text like 'b5000000-0000-4000-8000-0000000006%') = 4, 'S-5 incluyó una sesión antigua';
  assert (select count(*) from public.list_recent_backend_chat_sessions(now() - interval '14 days', 2)) = 2, 'S-5 límite ignorado';
end $$;

-- S-6: borrar una organización borra sus sesiones (privacidad).
do $$
begin
  delete from organizations where id = 'b5000000-0000-4000-8000-00000000000a';
  assert not exists (select 1 from backend_chat_sessions where id = 'b5000000-0000-4000-8000-0000000005a1'), 'S-6 sesión huérfana';
end $$;

select 'TODAS LAS PRUEBAS DE SESIONES DURABLES PASARON' as resultado;

rollback;
