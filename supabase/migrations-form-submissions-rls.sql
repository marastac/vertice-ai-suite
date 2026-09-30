-- Lead AI — Fase C: cierre de escrituras anónimas directas en
-- leads / form_submissions / lead_activity.
--
-- Contexto (ver la auditoría de Fase C completa para el detalle): hasta
-- ahora, cualquier cliente que conociera (o adivinara) un `formId` podía
-- escribir directamente estas tres tablas vía la API REST de Supabase con
-- la anon key — sin pasar por ninguna validación de servidor, sin rate
-- limiting, sin comprobar que el formulario estuviera activo, y pudiendo
-- fabricar organization_id/score/status a su antojo. Fase C mueve la
-- creación de leads desde un formulario público al backend Express
-- (POST /api/forms/:formId/submissions — ver server/src/routes/forms.ts),
-- que escribe con la credencial service_role. service_role bypasea RLS
-- por completo, así que las policies de esta migración NUNCA afectan a ese
-- endpoint nuevo — solo cierran la vía que lo evitaba.
--
-- Esta migración NO toca:
--   - forms_select (sigue pública, `using (true)` — /f/:formId sigue
--     pudiendo leer el formulario sin login, sin cambios);
--   - ninguna policy de SELECT/UPDATE/DELETE de leads/form_submissions/
--     lead_activity;
--   - el RPC upsert_chat_lead() (exclusivo del chat, sin relación con
--     formularios, SECURITY DEFINER, ya bypasea RLS independientemente);
--   - ninguna otra tabla, trigger o función.
--
-- Reemplaza ÚNICAMENTE las tres policies de INSERT que hoy permiten una
-- escritura anónima incondicional, por la MISMA condición is_org_editor()
-- que ya gobierna toda la escritura autenticada de leads/forms en este
-- proyecto (ver "Leads role permissions" en CLAUDE.md) — nunca se cierra a
-- "nadie", se cierra a "solo miembros editores autenticados de esa
-- organización". Esto preserva exactamente, sin cambios:
--   - useCreateLeadMutation()/useUpdateLeadMutation() ("Nuevo lead"/
--     "Editar" en el dashboard — ambas ya dependían de is_org_editor);
--   - src/migration/local-to-supabase.ts (herramienta de migración
--     one-time, dev-only, ejecutada por un owner/editor autenticado sobre
--     su propia organización).
--
-- Ejecutar una sola vez, sobre un proyecto que ya corrió schema.sql (o
-- schema.sql + las migraciones incrementales posteriores) — depende
-- únicamente de is_org_editor(), ya existente desde
-- migrations-leads-role-permissions.sql. Puramente restrictiva: no crea
-- tablas, no borra datos, no modifica ninguna fila existente.
--
-- NO EJECUTADA contra Supabase — preparada para revisión y aplicación
-- manual, igual que el resto de migraciones de este proyecto.

drop policy if exists "leads_insert" on leads;
create policy "leads_insert" on leads for insert with check (
  is_org_editor(organization_id)
);

drop policy if exists "form_submissions_insert" on form_submissions;
create policy "form_submissions_insert" on form_submissions for insert with check (
  is_org_editor(organization_id)
);

drop policy if exists "lead_activity_insert" on lead_activity;
create policy "lead_activity_insert" on lead_activity for insert with check (
  is_org_editor(organization_id)
);

-- ── verificación ────────────────────────────────────────────────────────
-- 1) Confirmar que las tres policies de INSERT quedaron exactamente así —
--    deben aparecer tres filas, cada una con qual/with_check apuntando a
--    is_org_editor(organization_id) y nada más.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in ('leads', 'form_submissions', 'lead_activity') and cmd = 'INSERT'
order by tablename;

-- 2) Confirmar que forms_select sigue intacta y pública (no debe cambiar).
select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename = 'forms' and policyname = 'forms_select';

-- 3) Prueba manual (después de aplicar, con el cliente anon key):
--    - `insert into leads (...)` directo desde un cliente sin sesión debe
--      fallar por violación de política RLS (antes de esta migración,
--      tenía éxito).
--    - El mismo insert desde un usuario autenticado con rol owner/admin/
--      member de esa organización debe seguir funcionando sin cambios.
--    - `insert into leads (...)` desde un usuario autenticado con rol
--      'viewer' de esa organización debe seguir fallando (sin cambios,
--      ya fallaba antes de esta migración).
