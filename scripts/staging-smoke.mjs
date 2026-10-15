#!/usr/bin/env node
// Smoke tests for a deployed MAASTAC AI STAGING environment (Vercel frontend +
// Railway backend + Supabase). Node only (built-in fetch), no dependencies.
//
// SAFE BY DEFAULT — nothing runs unless you explicitly target staging:
//   * Refuses to start (exit 2) unless STAGING_SMOKE_CONFIRM=staging.
//   * Refuses any URL whose host doesn't look like staging (must contain
//     "staging", or be listed in STAGING_ALLOWED_HOSTS) or is listed in
//     STAGING_FORBIDDEN_HOSTS (put production domains there).
//   * Refuses a Supabase service_role / secret key: only the PUBLIC anon key
//     is ever accepted. Keys are never printed.
//   * Default tier is read-only and free: no writes, no Anthropic calls.
//   * Optional tiers, each behind its own explicit variable:
//       STAGING_SMOKE_SESSION=1          creates 1 chat session (no Anthropic call)
//       STAGING_SMOKE_RLS=1              anon-key RLS checks against Supabase (read-only)
//       STAGING_SMOKE_PAID=1-message     sends ONE real chat message (paid Anthropic
//                                        call: reply + extraction). Any other value
//                                        (e.g. "1", "true") is ignored on purpose.
//
// Usage (see REPORTE_STAGING_AUTOMATIZADO.txt):
//   STAGING_SMOKE_CONFIRM=staging \
//   STAGING_API_URL=https://<backend-staging>.up.railway.app \
//   STAGING_FRONTEND_URL=https://<frontend-staging>.vercel.app \
//   npm run test:staging:smoke
//
// Exit codes: 0 all executed checks passed · 1 some check failed · 2 refused
// to run (configuration/safety). Skipped checks never fail the run.

const env = process.env
const TIMEOUT_MS = Number(env.STAGING_SMOKE_TIMEOUT_MS) || 15000

// Same patterns as scripts/check-production-bundle.mjs.
const FORBIDDEN_BUNDLE_TEXT = ['npm run dev:server', 'server/.env', 'Si eres parte del equipo', 'sk-ant-', 'service_role']

function refuse(message) {
  console.error(`✖ No se ejecuta: ${message}`)
  process.exit(2)
}

function list(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function checkUrl(name, raw) {
  if (!raw) refuse(`falta ${name}.`)
  let url
  try {
    url = new URL(raw)
  } catch {
    refuse(`${name} no es una URL válida.`)
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' && !LOOPBACK.has(host)) refuse(`${name} debe usar https.`)
  if (list(env.STAGING_FORBIDDEN_HOSTS).includes(host)) refuse(`${name} apunta a un host prohibido (${host}).`)
  if (!host.includes('staging') && !list(env.STAGING_ALLOWED_HOSTS).includes(host)) {
    refuse(`${name} (${host}) no parece de staging. Añádelo a STAGING_ALLOWED_HOSTS solo si estás seguro.`)
  }
  return url.origin
}

function decodeJwtRole(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role ?? null
  } catch {
    return null
  }
}

// ── Configuration & safety gate ──────────────────────────────────────────────
if (env.STAGING_SMOKE_CONFIRM !== 'staging') refuse('define STAGING_SMOKE_CONFIRM=staging para confirmar el destino.')

const apiOrigin = checkUrl('STAGING_API_URL', env.STAGING_API_URL)
const frontendOrigin = checkUrl('STAGING_FRONTEND_URL', env.STAGING_FRONTEND_URL)
const chatSlug = env.STAGING_CHAT_SLUG?.trim() || null

const wantSession = env.STAGING_SMOKE_SESSION === '1'
const wantRls = env.STAGING_SMOKE_RLS === '1'
const wantPaid = env.STAGING_SMOKE_PAID === '1-message'

let supabaseOrigin = null
const anonKey = env.STAGING_SUPABASE_ANON_KEY?.trim() || null
if (wantRls) {
  supabaseOrigin = checkUrl('STAGING_SUPABASE_URL', env.STAGING_SUPABASE_URL)
  if (!anonKey) refuse('STAGING_SMOKE_RLS=1 requiere STAGING_SUPABASE_ANON_KEY (la clave pública anon).')
}
if (anonKey && (anonKey.startsWith('sb_secret_') || decodeJwtRole(anonKey) === 'service_role')) {
  refuse('STAGING_SUPABASE_ANON_KEY es una clave de servicio (service_role/secret). Usa solo la clave pública anon.')
}
if ((wantSession || wantPaid) && !chatSlug) refuse('los niveles de sesión/pago requieren STAGING_CHAT_SLUG.')

// ── Helpers ──────────────────────────────────────────────────────────────────
const results = []

async function check(tier, name, fn) {
  try {
    const detail = await fn()
    results.push({ tier, name, status: 'pass', detail: detail ?? '' })
  } catch (error) {
    results.push({ tier, name, status: 'fail', detail: error instanceof Error ? error.message : String(error) })
  }
}

function skip(tier, name, reason) {
  results.push({ tier, name, status: 'skip', detail: reason })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function http(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })
}

async function json(response) {
  return response.json().catch(() => null)
}

// ── Default tier: read-only, free ────────────────────────────────────────────
let health = null
await check('base', 'Backend /api/health responde ok', async () => {
  const response = await http(`${apiOrigin}/api/health`)
  assert(response.status === 200, `HTTP ${response.status}`)
  health = await json(response)
  assert(health?.status === 'ok', 'status distinto de "ok"')
  return `aiConfigured=${health.aiConfigured} model=${health.model ?? 'null'}`
})

await check('base', 'Backend con IA configurada (aiConfigured=true)', async () => {
  assert(health, 'sin respuesta de /api/health')
  assert(health.aiConfigured === true, 'aiConfigured=false: falta ANTHROPIC_API_KEY en Railway staging')
})

await check('base', 'CORS permite el origen del frontend de staging', async () => {
  const response = await http(`${apiOrigin}/api/chat/sessions`, {
    method: 'OPTIONS',
    headers: { Origin: frontendOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  })
  const allowed = response.headers.get('access-control-allow-origin')
  // Exact match only: '*' would mean CORS is open to any site.
  assert(allowed === frontendOrigin, `access-control-allow-origin=${allowed ?? '(ausente)'}; revisa CORS_ORIGIN en Railway`)
  return `allow-origin=${allowed}`
})

await check('base', 'CORS rechaza un origen ajeno', async () => {
  const response = await http(`${apiOrigin}/api/chat/sessions`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://origen-ajeno.example', 'Access-Control-Request-Method': 'POST' },
  })
  const allowed = response.headers.get('access-control-allow-origin')
  assert(allowed !== 'https://origen-ajeno.example' && allowed !== '*', `un origen ajeno recibió allow-origin=${allowed}`)
})

let indexHtml = null
await check('base', 'Frontend carga (index.html)', async () => {
  const response = await http(`${frontendOrigin}/`)
  assert(response.status === 200, `HTTP ${response.status}`)
  indexHtml = await response.text()
  assert(indexHtml.includes('id="root"'), 'no es la SPA esperada (falta #root)')
})

await check('base', 'Rutas profundas de la SPA (reescritura de Vercel)', async () => {
  const path = `/c/${encodeURIComponent(chatSlug ?? 'smoke-test')}`
  const response = await http(`${frontendOrigin}${path}`)
  assert(response.status === 200, `${path} → HTTP ${response.status}; revisa vercel.json/Root Directory`)
  assert((await response.text()).includes('id="root"'), `${path} no devuelve la SPA`)
})

await check('base', 'Bundle sin detalles internos y apuntando al backend de staging', async () => {
  assert(indexHtml, 'sin index.html')
  const scripts = [...indexHtml.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => new URL(m[1], `${frontendOrigin}/`).href)
  assert(scripts.length > 0, 'no se encontraron scripts en index.html')
  const bundle = (await Promise.all(scripts.map(async (src) => (await http(src)).text()))).join('\n')
  const leaked = FORBIDDEN_BUNDLE_TEXT.filter((needle) => bundle.includes(needle))
  assert(leaked.length === 0, `el bundle contiene: ${leaked.join(', ')}`)
  assert(bundle.includes(apiOrigin), `el bundle no referencia ${apiOrigin}: revisa VITE_API_BASE_URL en Vercel`)
  return `${scripts.length} script(s) revisados`
})

// ── Optional tier: chat session (no Anthropic call) ─────────────────────────
let sessionId = null
if (wantSession || wantPaid) {
  await check('sesion', `Crear sesión de chat para "${chatSlug}" (201)`, async () => {
    const response = await http(`${apiOrigin}/api/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: frontendOrigin },
      body: JSON.stringify({ orgSlug: chatSlug }),
    })
    const body = await json(response)
    assert(response.status === 201, `HTTP ${response.status}: ${body?.error ?? 'sin mensaje'}`)
    assert(typeof body?.sessionId === 'string' && body.welcomeMessage && body.assistantName, 'respuesta incompleta')
    sessionId = body.sessionId
    return `assistantName="${body.assistantName}"`
  })

  await check('sesion', 'Slug inexistente → 404', async () => {
    const response = await http(`${apiOrigin}/api/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: frontendOrigin },
      body: JSON.stringify({ orgSlug: `no-existe-smoke-${Date.now()}` }),
    })
    assert(response.status === 404, `HTTP ${response.status}`)
  })

  await check('sesion', 'Mensaje vacío → 400 (validado antes de Anthropic, sin costo)', async () => {
    assert(sessionId, 'sin sesión')
    const response = await http(`${apiOrigin}/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: frontendOrigin },
      body: JSON.stringify({ message: '   ' }),
    })
    assert(response.status === 400, `HTTP ${response.status}`)
  })

  await check('sesion', 'Sesión inexistente → 404 (sin costo)', async () => {
    const response = await http(`${apiOrigin}/api/chat/sessions/00000000-0000-4000-8000-000000000000/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: frontendOrigin },
      body: JSON.stringify({ message: 'hola' }),
    })
    assert(response.status === 404, `HTTP ${response.status}`)
  })
} else {
  skip('sesion', 'Sesión de chat', 'STAGING_SMOKE_SESSION≠1')
}

// ── Optional tier: RLS with the PUBLIC anon key (read-only) ─────────────────
// STRICTLY READ-ONLY: every request in this tier goes through `restGet`, which
// only ever issues GET and refuses any other method. No RPC is called here:
// PostgREST only accepts POST for volatile functions, and even a call that RLS
// is expected to reject is still a call to a function that writes data.
// tests/staging-smoke.test.ts fails if this tier ever sends a non-GET request.
if (wantRls) {
  const restGet = (path, init = {}) => {
    if (init.method && init.method.toUpperCase() !== 'GET') {
      throw new Error(`el nivel RLS es solo lectura: método ${init.method} no permitido`)
    }
    return http(`${supabaseOrigin}/rest/v1/${path}`, {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    })
  }

  // Quota tables: REVOKE ALL from anon/authenticated → the request itself is denied.
  for (const table of ['usage_reservations', 'usage_periods', 'usage_conversations', 'organization_quotas', 'model_prices', 'plans']) {
    await check('rls', `anon NO puede leer ${table}`, async () => {
      const response = await restGet(`${table}?select=*&limit=1`)
      assert(response.status >= 400, `HTTP ${response.status}: la tabla es legible con la clave anon`)
      return `HTTP ${response.status}`
    })
  }

  // Member-only tables: anon passes the grant but RLS filters every row → [] (or a 4xx).
  for (const table of ['leads', 'lead_activity', 'form_submissions', 'chat_sessions', 'chat_messages', 'team_members', 'organization_members', 'organization_invites']) {
    await check('rls', `anon NO ve filas de ${table}`, async () => {
      const response = await restGet(`${table}?select=id&limit=1`)
      const body = await json(response)
      assert(
        response.status >= 400 || (Array.isArray(body) && body.length === 0),
        `anon recibió ${Array.isArray(body) ? body.length : '?'} fila(s) (HTTP ${response.status})`,
      )
      return response.status >= 400 ? `HTTP ${response.status}` : '0 filas'
    })
  }

  // H2 (supabase/migrations-public-read-hardening.sql): these three used to be
  // readable by anyone. FAILS until that migration is applied — on purpose:
  // it is how the migration is verified on staging.
  for (const table of ['organizations', 'forms', 'chat_configuration']) {
    await check('rls', `anon NO ve filas de ${table} (H2)`, async () => {
      const response = await restGet(`${table}?select=id&limit=1`)
      const body = await json(response)
      assert(
        response.status >= 400 || (Array.isArray(body) && body.length === 0),
        `anon recibió ${Array.isArray(body) ? body.length : '?'} fila(s): ¿falta aplicar migrations-public-read-hardening.sql?`,
      )
      return response.status >= 400 ? `HTTP ${response.status}` : '0 filas'
    })
  }
} else {
  skip('rls', 'RLS con clave anon', 'STAGING_SMOKE_RLS≠1')
}

// ── Optional tier: ONE paid message ─────────────────────────────────────────
if (wantPaid) {
  await check('pago', 'UN mensaje real: respuesta en streaming (costo Anthropic)', async () => {
    assert(sessionId, 'sin sesión')
    const response = await fetch(`${apiOrigin}/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: frontendOrigin },
      body: JSON.stringify({ message: 'Hola, esto es una prueba automática de staging. Responde en una frase.' }),
      signal: AbortSignal.timeout(Math.max(TIMEOUT_MS, 90000)),
    })
    assert(response.ok && response.body, `HTTP ${response.status}`)
    const text = await response.text()
    const events = [...text.matchAll(/^event: ([a-z_]+)$/gm)].map((m) => m[1])
    assert(!events.includes('error'), 'el backend envió un evento "error"')
    if (events.includes('conversation_limit_reached')) return 'bloqueado por cuota/límite (respuesta controlada, sin llamada a Anthropic)'
    assert(events.includes('delta'), 'sin texto de respuesta (delta)')
    assert(events.includes('done'), 'sin evento "done"')
    return `eventos: ${[...new Set(events)].join(', ')}`
  })
} else {
  skip('pago', 'Mensaje real (de pago)', 'STAGING_SMOKE_PAID≠1-message')
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n══════════ staging smoke — ${apiOrigin} · ${frontendOrigin} ══════════`)
for (const r of results) {
  const icon = r.status === 'pass' ? '✔' : r.status === 'fail' ? '✖' : '–'
  console.log(`${icon} [${r.tier}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
}
const failed = results.filter((r) => r.status === 'fail').length
const passed = results.filter((r) => r.status === 'pass').length
const skipped = results.filter((r) => r.status === 'skip').length
console.log(`\nRESULTADO: ${passed} OK, ${failed} fallos, ${skipped} omitidos`)
process.exit(failed === 0 ? 0 : 1)
