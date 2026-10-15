-- MAASTAC AI (técnicamente "Lead AI") — Aislamiento entre organizaciones en
-- upsert_chat_lead() (hallazgo H1 de REPORTE_AVANCE_MVP / REPORTE_SEGURIDAD_MVP).
--
-- upsert_chat_lead() es SECURITY DEFINER y ejecutable por anon (el chat
-- público la llama sin sesión), así que se salta RLS: todas las comprobaciones
-- tienen que estar DENTRO de la función. La versión anterior confiaba en los
-- parámetros p_organization_id y p_chat_session_id sin relacionarlos entre sí
-- ni con el lead existente.
--
-- Esta versión añade, antes de escribir nada:
--   1. p_chat_session_id debe ser el id (uuid) de una fila de chat_sessions
--      que pertenezca EXACTAMENTE a p_organization_id. Esa fila solo la crea
--      create_public_chat_session(), que ya exige organización + slug
--      coherentes y un chat activo.
--   2. El ON CONFLICT solo actualiza un lead de la MISMA organización. Si el
--      chat_session_id ya pertenece a un lead de otra organización, no se
--      modifica nada y la llamada falla.
-- Ambos casos fallan con el mismo error genérico (CHAT_SESSION_NOT_FOUND,
-- SQLSTATE 42501) para no revelar si una sesión o un lead existen en otra
-- organización.
--
-- El flujo legítimo no cambia: el chat público crea su sesión
-- (create_public_chat_session) al iniciar la conversación y solo después
-- llama a esta función con el MISMO id de sesión y su organización.
--
-- Misma firma, mismos permisos (anon + authenticated) y mismo valor devuelto:
-- no requiere cambios en el frontend.
--
-- Re-ejecutable. NO ejecutada contra Supabase: aplicar a mano en el SQL
-- editor, primero en STAGING. schema.sql contiene la misma función para
-- proyectos nuevos. Pruebas: supabase/tests-security-h1-h2.sql y
-- `npm run test:db:concurrency` (L1), siempre en un Postgres desechable.
--
-- Riesgo residual (documentado, no lo resuelve esta migración): cualquiera
-- puede abrir una sesión de chat pública en una organización con el chat
-- activo, igual que un visitante real, y registrar un lead en ESA
-- organización sin pasar por la IA. La solución estructural es que el backend
-- cree el lead (como ya hace con los formularios) y retirar EXECUTE a anon.

create or replace function public.upsert_chat_lead(
  p_organization_id uuid,
  p_chat_session_id text,
  p_name text,
  p_email text,
  p_phone text,
  p_company text,
  p_status text,
  p_score integer,
  p_notes text
)
returns leads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead leads;
  v_is_new boolean;
  v_session_id uuid;
  v_session_org uuid;
begin
  if p_organization_id is null then
    raise exception 'p_organization_id is required';
  end if;
  if p_chat_session_id is null or length(trim(p_chat_session_id)) = 0 then
    raise exception 'p_chat_session_id is required';
  end if;

  -- 1. The chat session must exist and belong to this exact organization.
  begin
    v_session_id := p_chat_session_id::uuid;
  exception when invalid_text_representation then
    raise exception 'CHAT_SESSION_NOT_FOUND' using errcode = '42501';
  end;
  select cs.organization_id into v_session_org from chat_sessions cs where cs.id = v_session_id;
  if v_session_org is null or v_session_org <> p_organization_id then
    raise exception 'CHAT_SESSION_NOT_FOUND' using errcode = '42501';
  end if;

  select not exists (select 1 from leads where chat_session_id = p_chat_session_id) into v_is_new;

  -- 2. ON CONFLICT never touches a lead of another organization.
  insert into leads (
    organization_id, name, email, phone, company, source, status, score, notes, chat_session_id, last_activity_at
  )
  values (
    p_organization_id, p_name, p_email, p_phone, p_company, 'chat', p_status, p_score, p_notes, p_chat_session_id, now()
  )
  on conflict (chat_session_id) do update set
    name = excluded.name,
    email = excluded.email,
    phone = excluded.phone,
    company = excluded.company,
    status = excluded.status,
    score = excluded.score,
    notes = excluded.notes,
    last_activity_at = now()
  where leads.organization_id = excluded.organization_id
  returning * into v_lead;

  if v_lead.id is null then
    raise exception 'CHAT_SESSION_NOT_FOUND' using errcode = '42501';
  end if;

  insert into lead_activity (organization_id, lead_id, message)
  values (
    v_lead.organization_id,
    v_lead.id,
    case when v_is_new
      then 'Lead creado automáticamente desde una conversación de chat con IA.'
      else 'Información del lead actualizada.'
    end
  );

  return v_lead;
end;
$$;

revoke all on function public.upsert_chat_lead(uuid, text, text, text, text, text, text, integer, text) from public;
grant execute on function public.upsert_chat_lead(uuid, text, text, text, text, text, text, integer, text) to anon, authenticated;

-- ── verificación (solo lectura) ────────────────────────────────────────────
-- La nueva versión contiene ambas comprobaciones.
select proname,
       position('CHAT_SESSION_NOT_FOUND' in prosrc) > 0 as checks_session,
       position('leads.organization_id = excluded.organization_id' in prosrc) > 0 as guards_conflict
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'upsert_chat_lead';

-- Leads de chat cuya sesión no existe o pertenece a otra organización
-- (posibles escrituras previas a esta corrección). Solo informativo: esta
-- migración NO borra ni modifica nada.
select l.id, l.organization_id, l.created_at
from public.leads l
left join public.chat_sessions cs on cs.id::text = l.chat_session_id
where l.chat_session_id is not null
  and (cs.id is null or cs.organization_id <> l.organization_id)
order by l.created_at desc
limit 100;

-- ── reversión (NO ejecutar salvo que se quiera deshacer) ───────────────────
-- Volver a ejecutar la definición anterior de upsert_chat_lead() (la de
-- migrations-public-chat-rpc.sql). Reabre el hallazgo H1.
