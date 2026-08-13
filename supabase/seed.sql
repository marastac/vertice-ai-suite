-- Lead AI — Phase 6 one-time seed
--
-- Run this once, AFTER schema.sql, in the Supabase SQL editor. Ports the
-- same demo data that today's localStorage repositories seed on first read
-- (src/entities/{lead,form,team-member}/mock-data.ts) — but as a one-time
-- script, not baked into any repository's read path. Baking a "seed on
-- empty read" pattern into a shared database would let concurrent empty
-- reads from different clients race to insert duplicate rows; a real
-- database doesn't have per-browser isolation to make that pattern safe
-- the way it was for localStorage.
--
-- Safe to re-run: every insert is `on conflict (id) do nothing`, keyed on
-- the fixed UUIDs below (chosen deterministically so cross-references
-- between tables can be written as plain literals, no CTEs needed). These
-- rows are NOT meant to match your real accumulated localStorage data —
-- that's a separate, per-user export/import step (see
-- src/entities/*/export-import.ts once implemented), not this file.
--
-- Phase 8: every row below belongs to one seeded "Vertice Digital"
-- organization (fixed id below). This script cannot know your auth.users
-- id, so it cannot make you a member of that organization automatically —
-- see the very bottom of this file for the one statement you still need to
-- run by hand after signing up, same as supabase/migrations-phase8.sql.
--
-- Phase 9: onboarding_completed_at is set below so this demo organization
-- never shows the /onboarding screen — it's meant to already look like an
-- established account with real data, not a brand-new sign-up.

-- ── organizations (seed org every other row below belongs to) ───────────
insert into organizations (id, name, slug, onboarding_completed_at) values
  ('00000000-0000-0000-0000-000000000000', 'Vertice Digital', 'vertice-agency', '2026-07-01T09:00:00Z')
on conflict (id) do nothing;

-- ── team_members (mirrors entities/team-member/mock-data.ts) ────────────
insert into team_members (id, organization_id, name, email, role) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'Alex Morgan', 'alex@leadai.app', 'owner'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'Jordan Lee', 'jordan@leadai.app', 'admin'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'Sam Rivera', 'sam@leadai.app', 'member')
on conflict (id) do nothing;

-- ── forms (mirrors entities/form/mock-data.ts) ───────────────────────────
insert into forms (id, organization_id, name, description, status, questions, created_at, updated_at) values
(
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000000',
  'Formulario de colaboraciones y patrocinios',
  'Califica propuestas de marcas y patrocinios antes de aceptar una colaboración.',
  'active',
  '[
    {"id":"form-01-q1","type":"short_text","label":"Nombre completo","required":true,"points":10},
    {"id":"form-01-q2","type":"email","label":"Correo electrónico","required":true,"points":20},
    {"id":"form-01-q3","type":"phone","label":"Teléfono","required":false,"points":5},
    {"id":"form-01-q4","type":"short_text","label":"Marca o proyecto","required":true,"points":10},
    {"id":"form-01-q5","type":"single_choice","label":"¿Cuál es el presupuesto de la colaboración?","required":true,
     "options":[
       {"id":"form-01-q5-o1","label":"Menos de 300 €","points":0},
       {"id":"form-01-q5-o2","label":"300 € - 1.000 €","points":15},
       {"id":"form-01-q5-o3","label":"1.000 € - 3.000 €","points":25},
       {"id":"form-01-q5-o4","label":"Más de 3.000 €","points":30}
     ]},
    {"id":"form-01-q6","type":"single_choice","label":"¿Cuándo te gustaría lanzar la colaboración?","required":true,
     "options":[
       {"id":"form-01-q6-o1","label":"Inmediatamente","points":15},
       {"id":"form-01-q6-o2","label":"En 1-3 meses","points":10},
       {"id":"form-01-q6-o3","label":"Más adelante","points":0}
     ]},
    {"id":"form-01-q7","type":"yes_no","label":"¿Tienes autoridad para aprobar el pago de la colaboración?","required":true,
     "options":[
       {"id":"form-01-q7-yes","label":"Sí","points":15},
       {"id":"form-01-q7-no","label":"No","points":0}
     ]},
    {"id":"form-01-q8","type":"long_text","label":"Cuéntanos sobre tu marca o campaña","required":false,"points":5}
  ]'::jsonb,
  '2026-07-05T10:00:00Z', '2026-07-12T09:30:00Z'
),
(
  '00000000-0000-0000-0000-000000000102',
  '00000000-0000-0000-0000-000000000000',
  'Formulario de inscripción a mi curso online',
  'Califica a los interesados en tu curso antes de invitarlos a inscribirse.',
  'active',
  '[
    {"id":"form-02-q1","type":"short_text","label":"Nombre completo","required":true,"points":10},
    {"id":"form-02-q2","type":"email","label":"Correo electrónico","required":true,"points":15},
    {"id":"form-02-q3","type":"single_choice","label":"¿Cuál es tu nivel de experiencia?","required":true,
     "options":[
       {"id":"form-02-q3-o1","label":"Principiante","points":10},
       {"id":"form-02-q3-o2","label":"Intermedio","points":15},
       {"id":"form-02-q3-o3","label":"Avanzado","points":10}
     ]},
    {"id":"form-02-q4","type":"yes_no","label":"¿Puedes invertir en el curso en este momento?","required":true,
     "options":[
       {"id":"form-02-q4-yes","label":"Sí","points":25},
       {"id":"form-02-q4-no","label":"No","points":0}
     ]},
    {"id":"form-02-q5","type":"single_choice","label":"¿Cuándo te gustaría empezar?","required":true,
     "options":[
       {"id":"form-02-q5-o1","label":"Inmediatamente","points":25},
       {"id":"form-02-q5-o2","label":"En 1-3 meses","points":15},
       {"id":"form-02-q5-o3","label":"Más adelante","points":0}
     ]},
    {"id":"form-02-q6","type":"long_text","label":"¿Cuál es tu objetivo principal al tomar el curso?","required":false,"points":10}
  ]'::jsonb,
  '2026-07-08T11:00:00Z', '2026-07-14T15:20:00Z'
),
(
  '00000000-0000-0000-0000-000000000103',
  '00000000-0000-0000-0000-000000000000',
  'Formulario de interés en mis productos o servicios',
  'Filtra clientes potenciales por presupuesto antes de contactarlos.',
  'draft',
  '[
    {"id":"form-03-q1","type":"short_text","label":"Nombre completo","required":true,"points":10},
    {"id":"form-03-q2","type":"email","label":"Correo electrónico","required":true,"points":15},
    {"id":"form-03-q3","type":"short_text","label":"¿Qué producto o servicio te interesa?","required":true,"points":10},
    {"id":"form-03-q4","type":"number","label":"Cantidad o volumen que necesitas","required":false,"points":5},
    {"id":"form-03-q5","type":"single_choice","label":"Presupuesto aproximado disponible","required":true,
     "options":[
       {"id":"form-03-q5-o1","label":"Menos de 100 €","points":0},
       {"id":"form-03-q5-o2","label":"100 € - 500 €","points":20},
       {"id":"form-03-q5-o3","label":"Más de 500 €","points":35}
     ]}
  ]'::jsonb,
  '2026-07-15T09:00:00Z', '2026-07-15T09:00:00Z'
)
on conflict (id) do nothing;

-- ── leads (mirrors entities/lead/mock-data.ts) ───────────────────────────
insert into leads (
  id, organization_id, name, email, phone, company, "position", source, status, score,
  estimated_budget, assigned_to, notes, created_at, last_activity_at
) values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000000', 'Elena Márquez', 'elena@brightpeakmarketing.com', '+34 611 203 344', 'Bright Peak Marketing', 'Directora de Marketing', 'chat', 'qualified', 88, 12000, '00000000-0000-0000-0000-000000000001', 'Interesada en un paquete de gestión de campañas para tres marcas.', '2026-07-10T09:15:00Z', '2026-07-16T14:02:00Z'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000000', 'Jaime Blanco', 'jaime@novaretail.io', '+34 622 447 921', 'Nova Retail Co.', 'Responsable de Ecommerce', 'form', 'qualifying', 61, 6000, '00000000-0000-0000-0000-000000000002', 'Solicita más información sobre integración con su tienda online.', '2026-07-12T11:40:00Z', '2026-07-16T10:22:00Z'),
  ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000000', 'Priya Nandakumar', 'priya@lumenhealth.com', null, 'Lumen Health Group', 'CEO', 'widget', 'new', 42, 20000, null, null, '2026-07-15T16:05:00Z', '2026-07-15T16:05:00Z'),
  ('00000000-0000-0000-0000-000000000204', '00000000-0000-0000-0000-000000000000', 'Marcos Delgado', 'marcos@forgeautomotive.com', '+34 633 668 810', 'Forge Automotive', 'Director Comercial', 'chat', 'converted', 95, 35000, '00000000-0000-0000-0000-000000000001', 'Cliente convertido tras la llamada de descubrimiento.', '2026-06-28T08:30:00Z', '2026-07-14T09:47:00Z'),
  ('00000000-0000-0000-0000-000000000205', '00000000-0000-0000-0000-000000000000', 'Sofía Trigo', 'sofia@driftwoodstudio.co', null, 'Driftwood Studio', 'Fundadora', 'form', 'disqualified', 18, 500, null, 'Presupuesto muy por debajo del mínimo del servicio.', '2026-07-08T13:12:00Z', '2026-07-09T17:00:00Z'),
  ('00000000-0000-0000-0000-000000000206', '00000000-0000-0000-0000-000000000000', 'Óscar Bermejo', 'oscar@keystonelegal.com', '+34 690 021 187', 'Keystone Legal Partners', 'Socio', 'manual', 'qualifying', 57, 9000, '00000000-0000-0000-0000-000000000003', 'Añadido manualmente tras una llamada telefónica.', '2026-07-13T10:00:00Z', '2026-07-16T08:11:00Z'),
  ('00000000-0000-0000-0000-000000000207', '00000000-0000-0000-0000-000000000000', 'Gracia Ocampo', 'gracia@summitfitness.com', null, 'Summit Fitness Collective', 'Directora de Operaciones', 'widget', 'qualified', 79, 15000, '00000000-0000-0000-0000-000000000002', 'Buscan lanzar campaña de captación para tres sedes nuevas.', '2026-07-11T15:20:00Z', '2026-07-15T12:35:00Z'),
  ('00000000-0000-0000-0000-000000000208', '00000000-0000-0000-0000-000000000000', 'Tomás Novak', 'tomas@brightpath.finance', '+34 633 356 620', 'BrightPath Finance', 'Director Financiero', 'chat', 'new', 33, 4000, null, null, '2026-07-16T07:45:00Z', '2026-07-16T07:45:00Z')
on conflict (id) do nothing;

-- ── lead_activity (mirrors each mock lead's embedded activity[]) ────────
-- organization_id is denormalized from the parent lead — see schema.sql's
-- note on why lead_activity carries its own copy instead of a join.
insert into lead_activity (organization_id, lead_id, message, created_at) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000201', 'Lead creado desde el chat de calificación.', '2026-07-10T09:15:00Z'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000201', 'Conversación completada con el asistente de IA.', '2026-07-12T10:30:00Z'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000201', 'Estado actualizado a "Calificado".', '2026-07-16T14:02:00Z'),

  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000202', 'Lead creado desde el formulario de calificación.', '2026-07-12T11:40:00Z'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000202', 'Información del lead actualizada.', '2026-07-16T10:22:00Z'),

  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000203', 'Lead creado desde el widget embebido.', '2026-07-15T16:05:00Z'),

  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000204', 'Lead creado desde el chat de calificación.', '2026-06-28T08:30:00Z'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000204', 'Estado actualizado a "Calificado".', '2026-07-05T12:00:00Z'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000204', 'Estado actualizado a "Convertido".', '2026-07-14T09:47:00Z'),

  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000205', 'Lead creado desde el formulario de calificación.', '2026-07-08T13:12:00Z'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000205', 'Estado actualizado a "Descalificado".', '2026-07-09T17:00:00Z'),

  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000206', 'Lead creado manualmente por el equipo.', '2026-07-13T10:00:00Z'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000206', 'Lead asignado a Sam Rivera.', '2026-07-16T08:11:00Z'),

  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000207', 'Lead creado desde el widget embebido.', '2026-07-11T15:20:00Z'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000207', 'Estado actualizado a "Calificado".', '2026-07-15T12:35:00Z'),

  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000208', 'Lead creado desde el chat de calificación.', '2026-07-16T07:45:00Z')
on conflict do nothing;

-- ── chat_configuration default row (mirrors entities/chat/defaults.ts) ──
-- Uses the same copy as createDefaultChatConfiguration() — the neutral
-- fallback template (Phase 9), not one of the business-type-specific ones
-- in entities/chat/business-type-templates.ts, since this demo organization
-- predates the onboarding flow (onboarding_completed_at is set above).
-- Criteria ids below are fresh UUID literals (the original uses
-- crypto.randomUUID() at runtime — any valid uuid is fine here).
insert into chat_configuration (
  organization_id, assistant_name, welcome_message, agency_description, services_offered,
  tone, language, questions_to_collect, criteria, min_qualified_score,
  additional_instructions, is_active
) values (
  '00000000-0000-0000-0000-000000000000',
  'Asistente virtual',
  '¡Hola! 👋 Gracias por escribir. Cuéntame en qué puedo ayudarte y con gusto te oriento.',
  'Negocio digital que ofrece contenido, cursos o productos y servicios a través de internet.',
  'Productos, servicios o contenido digital ofrecidos a través de internet.',
  'professional',
  'Español',
  array[
    'Nombre y correo electrónico de contacto',
    'Qué te interesa (producto, servicio o curso)',
    'Presupuesto aproximado',
    'Cuándo te gustaría empezar'
  ],
  '[
    {"id":"00000000-0000-0000-0000-000000000301","label":"Tiene una necesidad o interés claro","points":30},
    {"id":"00000000-0000-0000-0000-000000000302","label":"Cuenta con presupuesto disponible","points":30},
    {"id":"00000000-0000-0000-0000-000000000303","label":"Quiere avanzar pronto (menos de 1 mes)","points":20},
    {"id":"00000000-0000-0000-0000-000000000304","label":"Puede tomar la decisión por sí mismo/a","points":20}
  ]'::jsonb,
  70,
  '',
  true
)
on conflict (organization_id) do nothing;

-- ── you still need to run this — nothing above can do it for you ────────
-- This seed data belongs to the 'vertice-agency' organization seeded above,
-- but nothing here can make YOUR account a member of it — sign up through
-- the app first (POST /register), find your user id (Supabase dashboard →
-- Authentication → Users → your account → "UID"), then run:
--
-- insert into organization_members (organization_id, user_id, role)
-- values ('00000000-0000-0000-0000-000000000000', '<YOUR-AUTH-UID-HERE>', 'owner');
--
-- Without this, the app auto-provisions a separate, empty personal
-- organization for you instead of connecting you to this seed data.

-- ── verification ──────────────────────────────────────────────────────────
-- Run this file's INSERTs above, then read the result set below directly in
-- the SQL Editor's own results pane. This is the ground truth — trust this
-- over Table Editor, which is a separate read path and can show a stale/
-- cached view. Expect: organizations=1, team_members=3, forms=3, leads=8,
-- lead_activity=16, chat_configuration=1. If any of these come back 0, the
-- insert above it did not commit — re-run this whole file and check the SQL
-- Editor's error output for that block specifically (a later failing
-- statement in this same script rolls back every earlier insert in the same
-- run, including ones that looked fine).
select 'organizations' as table_name, count(*) from organizations
union all
select 'team_members', count(*) from team_members
union all
select 'forms', count(*) from forms
union all
select 'leads', count(*) from leads
union all
select 'lead_activity', count(*) from lead_activity
union all
select 'chat_configuration', count(*) from chat_configuration;
