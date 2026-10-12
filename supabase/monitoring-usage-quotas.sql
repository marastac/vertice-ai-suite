-- MAASTAC AI — Consultas de vigilancia de precios y modelos para las cuotas.
--
-- SOLO LECTURA: ninguna consulta de este archivo escribe nada. Ejecutar en
-- el SQL editor del proyecto correspondiente (staging o producción) cuando
-- se quiera revisar, después de aplicar migrations-usage-quotas.sql.
-- Requiere también la tabla usage_events (migrations-usage-events.sql); por
-- eso estas consultas viven aquí y no en la migración de cuotas.
--
-- Contexto y procedimiento de carga de precios: CLAUDE.md, sección
-- "Monthly chat quotas".

-- ── 1. Qué identificadores de modelo devuelve REALMENTE la API ─────────────
-- (Paso 1 del procedimiento de carga de precios.) Cada valor que aparezca
-- aquí necesita su propia fila en model_prices. Si solo aparece el mismo
-- valor que ANTHROPIC_MODEL, no hay problema de alias.
select model, count(*) as calls, min(created_at) as first_seen, max(created_at) as last_seen
from public.usage_events
where created_at > now() - interval '30 days'
group by model
order by calls desc;

-- ── 2. Modelos reportados por la API SIN fila de precio ────────────────────
-- Debe devolver CERO filas antes de activar 'shadow' o 'enforce'. Cada
-- modelo que aparezca aquí, en 'enforce', haría liquidar por la estimación
-- completa ('reservation_price') o, si es el configurado, denegar todo.
select distinct e.model
from public.usage_events e
left join public.model_prices p on p.model = e.model
where p.model is null
order by 1;

-- ── 3. Liquidaciones 'reservation_price' (sobrecobro) ─────────────────────
-- Debe devolver CERO filas. Cada una es una llamada cuyo modelo reportado no
-- tenía precio: se cobró al menos la estimación completa.
select actual_model, count(*) as settlements, sum(actual_micros) as micros,
       min(settled_at) as first_seen, max(settled_at) as last_seen
from public.usage_reservations
where settlement_basis = 'reservation_price'
group by actual_model
order by settlements desc;

-- ── 4. Modelo reportado distinto del reservado ─────────────────────────────
-- Esperado: cero filas con los modelos actuales. Si aparecen, cada par
-- (modelo, actual_model) necesita la fila de precio de actual_model.
select model as reserved_model, actual_model, count(*) as settlements
from public.usage_reservations
where actual_model is not null and actual_model <> model
group by model, actual_model
order by settlements desc;

-- ── 5. Control de los precios cargados ─────────────────────────────────────
-- El costo de 1.000.000 de tokens debe ser EXACTAMENTE el precio oficial por
-- millón en micro-USD (p. ej. US$5/MTok → 5000000). Compararlo, junto con
-- source_url y verified_on, con la página oficial de precios de Anthropic.
select model,
       public.quota_cost_micros(1000000, 0, input_micros_per_mtok, output_micros_per_mtok) as input_1m_micros,
       public.quota_cost_micros(0, 1000000, input_micros_per_mtok, output_micros_per_mtok) as output_1m_micros,
       source_url, verified_on, updated_at
from public.model_prices
order by model;

-- ── 6. Precios con verificación antigua ────────────────────────────────────
-- Filas cuya verificación tiene más de 90 días: revisar de nuevo la página
-- oficial (los precios pueden cambiar).
select model, verified_on, source_url
from public.model_prices
where verified_on < current_date - 90
order by verified_on;
