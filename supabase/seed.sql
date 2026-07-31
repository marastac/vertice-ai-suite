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

-- ── team_members (mirrors entities/team-member/mock-data.ts) ────────────
insert into team_members (id, name, email, role) values
  ('00000000-0000-0000-0000-000000000001', 'Alex Morgan', 'alex@verticeagency.com', 'owner'),
  ('00000000-0000-0000-0000-000000000002', 'Jordan Lee', 'jordan@verticeagency.com', 'admin'),
  ('00000000-0000-0000-0000-000000000003', 'Sam Rivera', 'sam@verticeagency.com', 'member')
on conflict (id) do nothing;

-- ── forms (mirrors entities/form/mock-data.ts) ───────────────────────────
insert into forms (id, name, description, status, questions, created_at, updated_at) values
(
  '00000000-0000-0000-0000-000000000101',
  'Formulario de descubrimiento para agencias',
  'Califica agencias potenciales antes de la primera llamada de descubrimiento.',
  'active',
  '[
    {"id":"form-01-q1","type":"short_text","label":"Nombre completo","required":true,"points":10},
    {"id":"form-01-q2","type":"email","label":"Correo electrónico","required":true,"points":20},
    {"id":"form-01-q3","type":"phone","label":"Teléfono","required":false,"points":5},
    {"id":"form-01-q4","type":"short_text","label":"Empresa","required":true,"points":10},
    {"id":"form-01-q5","type":"single_choice","label":"¿Cuál es tu presupuesto mensual de marketing?","required":true,
     "options":[
       {"id":"form-01-q5-o1","label":"Menos de 1.000 €","points":0},
       {"id":"form-01-q5-o2","label":"1.000 € - 5.000 €","points":15},
       {"id":"form-01-q5-o3","label":"5.000 € - 15.000 €","points":25},
       {"id":"form-01-q5-o4","label":"Más de 15.000 €","points":30}
     ]},
    {"id":"form-01-q6","type":"single_choice","label":"¿Cuándo te gustaría empezar?","required":true,
     "options":[
       {"id":"form-01-q6-o1","label":"Inmediatamente","points":15},
       {"id":"form-01-q6-o2","label":"En 1-3 meses","points":10},
       {"id":"form-01-q6-o3","label":"Más adelante","points":0}
     ]},
    {"id":"form-01-q7","type":"yes_no","label":"¿Tienes autoridad para tomar decisiones de compra?","required":true,
     "options":[
       {"id":"form-01-q7-yes","label":"Sí","points":15},
       {"id":"form-01-q7-no","label":"No","points":0}
     ]},
    {"id":"form-01-q8","type":"long_text","label":"Cuéntanos sobre tus objetivos","required":false,"points":5}
  ]'::jsonb,
  '2026-07-05T10:00:00Z', '2026-07-12T09:30:00Z'
),
(
  '00000000-0000-0000-0000-000000000102',
  'Calificador de encaje para ecommerce',
  'Evalúa si una tienda online encaja con nuestros servicios de marketing.',
  'active',
  '[
    {"id":"form-02-q1","type":"short_text","label":"Nombre completo","required":true,"points":10},
    {"id":"form-02-q2","type":"email","label":"Correo electrónico","required":true,"points":15},
    {"id":"form-02-q3","type":"short_text","label":"Empresa","required":true,"points":10},
    {"id":"form-02-q4","type":"single_choice","label":"¿Qué plataforma de ecommerce utilizas?","required":true,
     "options":[
       {"id":"form-02-q4-o1","label":"Shopify","points":15},
       {"id":"form-02-q4-o2","label":"WooCommerce","points":10},
       {"id":"form-02-q4-o3","label":"Otra","points":5},
       {"id":"form-02-q4-o4","label":"Ninguna todavía","points":0}
     ]},
    {"id":"form-02-q5","type":"single_choice","label":"¿Cuál es tu facturación mensual aproximada?","required":true,
     "options":[
       {"id":"form-02-q5-o1","label":"Menos de 5.000 €","points":0},
       {"id":"form-02-q5-o2","label":"5.000 € - 20.000 €","points":15},
       {"id":"form-02-q5-o3","label":"Más de 20.000 €","points":25}
     ]},
    {"id":"form-02-q6","type":"yes_no","label":"¿Inviertes actualmente en publicidad digital?","required":true,
     "options":[
       {"id":"form-02-q6-yes","label":"Sí","points":15},
       {"id":"form-02-q6-no","label":"No","points":0}
     ]}
  ]'::jsonb,
  '2026-07-08T11:00:00Z', '2026-07-14T15:20:00Z'
),
(
  '00000000-0000-0000-0000-000000000103',
  'Filtro de presupuesto empresarial',
  'Filtra leads empresariales por presupuesto disponible antes de asignar un ejecutivo de cuentas.',
  'draft',
  '[
    {"id":"form-03-q1","type":"short_text","label":"Nombre completo","required":true,"points":10},
    {"id":"form-03-q2","type":"email","label":"Correo electrónico","required":true,"points":15},
    {"id":"form-03-q3","type":"short_text","label":"Empresa","required":true,"points":10},
    {"id":"form-03-q4","type":"number","label":"Número de empleados","required":false,"points":5},
    {"id":"form-03-q5","type":"single_choice","label":"Presupuesto anual disponible","required":true,
     "options":[
       {"id":"form-03-q5-o1","label":"Menos de 10.000 €","points":0},
       {"id":"form-03-q5-o2","label":"10.000 € - 50.000 €","points":20},
       {"id":"form-03-q5-o3","label":"Más de 50.000 €","points":35}
     ]}
  ]'::jsonb,
  '2026-07-15T09:00:00Z', '2026-07-15T09:00:00Z'
)
on conflict (id) do nothing;

-- ── leads (mirrors entities/lead/mock-data.ts) ───────────────────────────
insert into leads (
  id, name, email, phone, company, "position", source, status, score,
  estimated_budget, assigned_to, notes, created_at, last_activity_at
) values
  ('00000000-0000-0000-0000-000000000201', 'Elena Márquez', 'elena@brightpeakmarketing.com', '+34 611 203 344', 'Bright Peak Marketing', 'Directora de Marketing', 'chat', 'qualified', 88, 12000, '00000000-0000-0000-0000-000000000001', 'Interesada en un paquete de gestión de campañas para tres marcas.', '2026-07-10T09:15:00Z', '2026-07-16T14:02:00Z'),
  ('00000000-0000-0000-0000-000000000202', 'Jaime Blanco', 'jaime@novaretail.io', '+34 622 447 921', 'Nova Retail Co.', 'Responsable de Ecommerce', 'form', 'qualifying', 61, 6000, '00000000-0000-0000-0000-000000000002', 'Solicita más información sobre integración con su tienda online.', '2026-07-12T11:40:00Z', '2026-07-16T10:22:00Z'),
  ('00000000-0000-0000-0000-000000000203', 'Priya Nandakumar', 'priya@lumenhealth.com', null, 'Lumen Health Group', 'CEO', 'widget', 'new', 42, 20000, null, null, '2026-07-15T16:05:00Z', '2026-07-15T16:05:00Z'),
  ('00000000-0000-0000-0000-000000000204', 'Marcos Delgado', 'marcos@forgeautomotive.com', '+34 633 668 810', 'Forge Automotive', 'Director Comercial', 'chat', 'converted', 95, 35000, '00000000-0000-0000-0000-000000000001', 'Cliente convertido tras la llamada de descubrimiento.', '2026-06-28T08:30:00Z', '2026-07-14T09:47:00Z'),
  ('00000000-0000-0000-0000-000000000205', 'Sofía Trigo', 'sofia@driftwoodstudio.co', null, 'Driftwood Studio', 'Fundadora', 'form', 'disqualified', 18, 500, null, 'Presupuesto muy por debajo del mínimo del servicio.', '2026-07-08T13:12:00Z', '2026-07-09T17:00:00Z'),
  ('00000000-0000-0000-0000-000000000206', 'Óscar Bermejo', 'oscar@keystonelegal.com', '+34 690 021 187', 'Keystone Legal Partners', 'Socio', 'manual', 'qualifying', 57, 9000, '00000000-0000-0000-0000-000000000003', 'Añadido manualmente tras una llamada telefónica.', '2026-07-13T10:00:00Z', '2026-07-16T08:11:00Z'),
  ('00000000-0000-0000-0000-000000000207', 'Gracia Ocampo', 'gracia@summitfitness.com', null, 'Summit Fitness Collective', 'Directora de Operaciones', 'widget', 'qualified', 79, 15000, '00000000-0000-0000-0000-000000000002', 'Buscan lanzar campaña de captación para tres sedes nuevas.', '2026-07-11T15:20:00Z', '2026-07-15T12:35:00Z'),
  ('00000000-0000-0000-0000-000000000208', 'Tomás Novak', 'tomas@brightpath.finance', '+34 633 356 620', 'BrightPath Finance', 'Director Financiero', 'chat', 'new', 33, 4000, null, null, '2026-07-16T07:45:00Z', '2026-07-16T07:45:00Z')
on conflict (id) do nothing;

-- ── lead_activity (mirrors each mock lead's embedded activity[]) ────────
insert into lead_activity (lead_id, message, created_at) values
  ('00000000-0000-0000-0000-000000000201', 'Lead creado desde el chat de calificación.', '2026-07-10T09:15:00Z'),
  ('00000000-0000-0000-0000-000000000201', 'Conversación completada con el asistente de IA.', '2026-07-12T10:30:00Z'),
  ('00000000-0000-0000-0000-000000000201', 'Estado actualizado a "Calificado".', '2026-07-16T14:02:00Z'),

  ('00000000-0000-0000-0000-000000000202', 'Lead creado desde el formulario de calificación.', '2026-07-12T11:40:00Z'),
  ('00000000-0000-0000-0000-000000000202', 'Información del lead actualizada.', '2026-07-16T10:22:00Z'),

  ('00000000-0000-0000-0000-000000000203', 'Lead creado desde el widget embebido.', '2026-07-15T16:05:00Z'),

  ('00000000-0000-0000-0000-000000000204', 'Lead creado desde el chat de calificación.', '2026-06-28T08:30:00Z'),
  ('00000000-0000-0000-0000-000000000204', 'Estado actualizado a "Calificado".', '2026-07-05T12:00:00Z'),
  ('00000000-0000-0000-0000-000000000204', 'Estado actualizado a "Convertido".', '2026-07-14T09:47:00Z'),

  ('00000000-0000-0000-0000-000000000205', 'Lead creado desde el formulario de calificación.', '2026-07-08T13:12:00Z'),
  ('00000000-0000-0000-0000-000000000205', 'Estado actualizado a "Descalificado".', '2026-07-09T17:00:00Z'),

  ('00000000-0000-0000-0000-000000000206', 'Lead creado manualmente por el equipo.', '2026-07-13T10:00:00Z'),
  ('00000000-0000-0000-0000-000000000206', 'Lead asignado a Sam Rivera.', '2026-07-16T08:11:00Z'),

  ('00000000-0000-0000-0000-000000000207', 'Lead creado desde el widget embebido.', '2026-07-11T15:20:00Z'),
  ('00000000-0000-0000-0000-000000000207', 'Estado actualizado a "Calificado".', '2026-07-15T12:35:00Z'),

  ('00000000-0000-0000-0000-000000000208', 'Lead creado desde el chat de calificación.', '2026-07-16T07:45:00Z')
on conflict do nothing;

-- ── chat_configuration default row (mirrors entities/chat/defaults.ts) ──
-- Uses the same copy as createDefaultChatConfiguration(). Criteria ids
-- below are fresh UUID literals (the original uses crypto.randomUUID() at
-- runtime — any valid uuid is fine, nothing keys off these specific values).
insert into chat_configuration (
  org_slug, assistant_name, welcome_message, agency_description, services_offered,
  tone, language, questions_to_collect, criteria, min_qualified_score,
  additional_instructions, is_active
) values (
  'vertice-agency',
  'Asistente de Vértice',
  '¡Hola! 👋 Soy el asistente virtual de la agencia. Cuéntame un poco sobre tu proyecto y te ayudo a ver si encajamos bien.',
  'Agencia de marketing digital especializada en captación y calificación de leads con inteligencia artificial.',
  'Marketing digital, generación de leads, automatización con IA, gestión de campañas publicitarias.',
  'professional',
  'Español',
  array[
    'Nombre y correo electrónico de contacto',
    'Tipo de negocio o industria',
    'Servicio de interés',
    'Presupuesto aproximado',
    'Plazo estimado para arrancar'
  ],
  '[
    {"id":"00000000-0000-0000-0000-000000000301","label":"Tiene un presupuesto definido","points":30},
    {"id":"00000000-0000-0000-0000-000000000302","label":"La necesidad es clara y específica","points":30},
    {"id":"00000000-0000-0000-0000-000000000303","label":"Plazo de arranque próximo (menos de 3 meses)","points":20},
    {"id":"00000000-0000-0000-0000-000000000304","label":"Tiene autoridad para decidir la contratación","points":20}
  ]'::jsonb,
  70,
  '',
  true
)
on conflict (org_slug) do nothing;

-- ── verification ──────────────────────────────────────────────────────────
-- Run this file's INSERTs above, then read the result set below directly in
-- the SQL Editor's own results pane. This is the ground truth — trust this
-- over Table Editor, which is a separate read path and can show a stale/
-- cached view. Expect: team_members=3, forms=3, leads=8, lead_activity=16,
-- chat_configuration=1. If any of these come back 0, the insert above it
-- did not commit — re-run this whole file and check the SQL Editor's error
-- output for that block specifically (a later failing statement in this
-- same script rolls back every earlier insert in the same run, including
-- ones that looked fine).
select 'team_members' as table_name, count(*) from team_members
union all
select 'forms', count(*) from forms
union all
select 'leads', count(*) from leads
union all
select 'lead_activity', count(*) from lead_activity
union all
select 'chat_configuration', count(*) from chat_configuration;
