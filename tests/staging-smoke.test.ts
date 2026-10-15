// Tests for scripts/staging-smoke.mjs against LOCAL mock servers (127.0.0.1)
// — never against real staging. Proves what the suite checks, and above all
// what it refuses to do (wrong target, service keys, paid calls without the
// exact opt-in). Runs on Node's built-in test runner through the backend's
// `tsx` (included in `npm run test:all:safe`).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

const SCRIPT = path.resolve('scripts', 'staging-smoke.mjs')

interface Recorded {
  server: 'api' | 'front' | 'supabase'
  method: string
  url: string
  body: string
}

const behavior = {
  aiConfigured: true,
  corsAllowsFrontend: true,
  bundleExtra: '',
  quotaTablesReadable: false,
  memberTableLeaks: false,
}
let requests: Recorded[] = []
let apiOrigin = ''
let frontOrigin = ''
let supabaseOrigin = ''
const servers: Server[] = []

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function start(name: Recorded['server'], handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer(async (req, res) => {
    const body = await readBody(req)
    requests.push({ server: name, method: req.method ?? '', url: req.url ?? '', body })
    handler(req, res, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

before(async () => {
  apiOrigin = await start('api', (req, res, body) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/api/health') {
      return send(res, 200, { status: 'ok', aiConfigured: behavior.aiConfigured, model: 'test-model', timestamp: 'now' })
    }
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin
      const allow = behavior.corsAllowsFrontend && origin === frontOrigin ? { 'Access-Control-Allow-Origin': origin } : {}
      res.writeHead(204, allow as Record<string, string>)
      return res.end()
    }
    if (req.method === 'POST' && url === '/api/chat/sessions') {
      const { orgSlug } = JSON.parse(body || '{}')
      return orgSlug === 'demo'
        ? send(res, 201, { sessionId: 's-1', welcomeMessage: 'Hola', assistantName: 'Asistente Demo' })
        : send(res, 404, { error: 'Esta organización no existe o no está disponible.' })
    }
    const match = url.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'POST' && match) {
      if (match[1] !== 's-1') return send(res, 404, { error: 'Esta conversación ya no está disponible.' })
      const { message } = JSON.parse(body || '{}')
      if (!message || !String(message).trim()) return send(res, 400, { error: 'Escribe un mensaje.' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      return res.end('event: delta\ndata: {"text":"Hola"}\n\nevent: qualification\ndata: {"qualification":null}\n\nevent: done\ndata: {}\n\n')
    }
    send(res, 404, { error: 'not found' })
  })
  frontOrigin = await start('front', (req, res) => {
    const url = req.url ?? ''
    if (url === '/assets/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      return res.end(`const API="${apiOrigin}";${behavior.bundleExtra}`)
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>')
  })
  supabaseOrigin = await start('supabase', (req, res) => {
    const url = req.url ?? ''
    // Member-only tables: RLS filters every row for anon → 200 [].
    if (/^\/rest\/v1\/(leads|lead_activity|form_submissions|chat_sessions|chat_messages|team_members|organization_members|organization_invites|organizations|forms|chat_configuration)\?/.test(url)) {
      return send(res, 200, behavior.memberTableLeaks && url.startsWith('/rest/v1/chat_messages') ? [{ id: 'leak' }] : [])
    }
    if (behavior.quotaTablesReadable && url.startsWith('/rest/v1/usage_reservations')) return send(res, 200, [{ id: 'x' }])
    send(res, 401, { code: '42501', message: 'permission denied' })
  })
})

after(() => {
  for (const server of servers) server.close()
})

beforeEach(() => {
  requests = []
  Object.assign(behavior, { aiConfigured: true, corsAllowsFrontend: true, bundleExtra: '', quotaTablesReadable: false, memberTableLeaks: false })
})

const ANON_KEY = 'sb_publishable_TESTKEY_never_printed_123'

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    STAGING_SMOKE_CONFIRM: 'staging',
    STAGING_API_URL: apiOrigin,
    STAGING_FRONTEND_URL: frontOrigin,
    STAGING_ALLOWED_HOSTS: '127.0.0.1',
    STAGING_SMOKE_TIMEOUT_MS: '5000',
    ...extra,
  }
}

function runSmoke(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('close', (code) => resolve({ code, output }))
  })
}

const paidMessages = () => requests.filter((r) => r.server === 'api' && r.url === '/api/chat/sessions/s-1/messages' && /"message":"[^"\s]/.test(r.body))

// ── Safety gate: refuses to run ──────────────────────────────────────────────

test('refuses without STAGING_SMOKE_CONFIRM=staging — and makes no request at all', async () => {
  const { code, output } = await runSmoke(baseEnv({ STAGING_SMOKE_CONFIRM: '' }))
  assert.equal(code, 2)
  assert.match(output, /STAGING_SMOKE_CONFIRM/)
  assert.equal(requests.length, 0)
})

test('refuses a host that does not look like staging (e.g. production)', async () => {
  const { code, output } = await runSmoke(baseEnv({ STAGING_API_URL: 'https://api.maastac.com', STAGING_ALLOWED_HOSTS: '' }))
  assert.equal(code, 2)
  assert.match(output, /no parece de staging/)
  assert.equal(requests.length, 0)
})

test('refuses a host listed in STAGING_FORBIDDEN_HOSTS even if it contains "staging"', async () => {
  const { code } = await runSmoke(
    baseEnv({ STAGING_FRONTEND_URL: 'https://staging.maastac.com', STAGING_FORBIDDEN_HOSTS: 'staging.maastac.com' }),
  )
  assert.equal(code, 2)
  assert.equal(requests.length, 0)
})

test('refuses plain http for non-loopback hosts', async () => {
  const { code } = await runSmoke(baseEnv({ STAGING_API_URL: 'http://api-staging.example.com' }))
  assert.equal(code, 2)
})

test('refuses a Supabase service_role JWT or sb_secret_ key — never runs with service credentials', async () => {
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')
  for (const key of [`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`, 'sb_secret_abcdef1234567890']) {
    const { code, output } = await runSmoke(
      baseEnv({ STAGING_SMOKE_RLS: '1', STAGING_SUPABASE_URL: supabaseOrigin, STAGING_SUPABASE_ANON_KEY: key }),
    )
    assert.equal(code, 2)
    assert.match(output, /clave de servicio/)
    assert.ok(!output.includes(key), 'printed the key')
  }
  assert.equal(requests.length, 0)
})

// ── Default tier: read-only ──────────────────────────────────────────────────

test('default tier on a healthy staging: exit 0, and ONLY reads (no POST at all)', async () => {
  const { code, output } = await runSmoke(baseEnv())
  assert.equal(code, 0, output)
  assert.match(output, /RESULTADO: 7 OK, 0 fallos, 3 omitidos/)
  assert.ok(requests.every((r) => r.method === 'GET' || r.method === 'OPTIONS'), 'default tier wrote something')
})

test('detects developer hints leaking into the production bundle', async () => {
  behavior.bundleExtra = 'const hint="npm run dev:server";'
  const { code, output } = await runSmoke(baseEnv())
  assert.equal(code, 1)
  assert.match(output, /el bundle contiene: npm run dev:server/)
})

test('detects a CORS_ORIGIN that does not match the frontend', async () => {
  behavior.corsAllowsFrontend = false
  const { code, output } = await runSmoke(baseEnv())
  assert.equal(code, 1)
  assert.match(output, /revisa CORS_ORIGIN/)
})

test('detects a backend without the Anthropic key (aiConfigured=false)', async () => {
  behavior.aiConfigured = false
  const { code, output } = await runSmoke(baseEnv())
  assert.equal(code, 1)
  assert.match(output, /falta ANTHROPIC_API_KEY/)
})

// ── Optional tiers ───────────────────────────────────────────────────────────

test('session tier: creates ONE session and checks 404/400 paths — never sends a real message', async () => {
  const { code, output } = await runSmoke(baseEnv({ STAGING_SMOKE_SESSION: '1', STAGING_CHAT_SLUG: 'demo' }))
  assert.equal(code, 0, output)
  assert.equal(requests.filter((r) => r.method === 'POST' && r.url === '/api/chat/sessions' && r.body.includes('"demo"')).length, 1)
  assert.equal(paidMessages().length, 0, 'sent a paid message')
})

test('the paid tier needs EXACTLY STAGING_SMOKE_PAID=1-message — "1" or "true" never send a paid message', async () => {
  for (const value of ['1', 'true', 'yes']) {
    requests = []
    const { code } = await runSmoke(baseEnv({ STAGING_SMOKE_SESSION: '1', STAGING_CHAT_SLUG: 'demo', STAGING_SMOKE_PAID: value }))
    assert.equal(code, 0)
    assert.equal(paidMessages().length, 0, `STAGING_SMOKE_PAID=${value} sent a paid message`)
  }
})

test('paid tier with the exact opt-in sends exactly ONE message and validates the stream', async () => {
  const { code, output } = await runSmoke(baseEnv({ STAGING_CHAT_SLUG: 'demo', STAGING_SMOKE_PAID: '1-message' }))
  assert.equal(code, 0, output)
  assert.equal(paidMessages().length, 1)
  assert.match(output, /eventos: delta, qualification, done/)
})

test('RLS tier: passes when anon is denied, fails if a quota table is readable — key never printed', async () => {
  const env = baseEnv({ STAGING_SMOKE_RLS: '1', STAGING_SUPABASE_URL: supabaseOrigin, STAGING_SUPABASE_ANON_KEY: ANON_KEY })
  const ok = await runSmoke(env)
  assert.equal(ok.code, 0, ok.output)
  assert.ok(!ok.output.includes(ANON_KEY))

  behavior.quotaTablesReadable = true
  const leaky = await runSmoke(env)
  assert.equal(leaky.code, 1)
  assert.match(leaky.output, /usage_reservations — HTTP 200: la tabla es legible/)
})

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

test('RLS tier is strictly read-only: every Supabase request is a GET, no RPC, and no write anywhere', async () => {
  const { code, output } = await runSmoke(
    baseEnv({ STAGING_SMOKE_RLS: '1', STAGING_SUPABASE_URL: supabaseOrigin, STAGING_SUPABASE_ANON_KEY: ANON_KEY }),
  )
  assert.equal(code, 0, output)
  const supabase = requests.filter((r) => r.server === 'supabase')
  assert.equal(supabase.length, 17, 'expected 6 quota tables + 8 member-only tables + 3 H2 tables')
  assert.deepEqual([...new Set(supabase.map((r) => r.method))], ['GET'])
  assert.ok(supabase.every((r) => !r.url.startsWith('/rest/v1/rpc/')), 'the RLS tier called an RPC')
  assert.ok(supabase.every((r) => r.body === ''), 'the RLS tier sent a request body')
  assert.equal(requests.filter((r) => WRITE_METHODS.has(r.method)).length, 0, 'base + RLS sent a write request')
})

test('RLS tier fails if anon can read rows of a member-only table (e.g. chat_messages)', async () => {
  behavior.memberTableLeaks = true
  const { code, output } = await runSmoke(
    baseEnv({ STAGING_SMOKE_RLS: '1', STAGING_SUPABASE_URL: supabaseOrigin, STAGING_SUPABASE_ANON_KEY: ANON_KEY }),
  )
  assert.equal(code, 1)
  assert.match(output, /anon NO ve filas de chat_messages — anon recibió 1 fila/)
})

test('static guard: the RLS section of the script contains no write method and no RPC path', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const start = source.indexOf('// ── Optional tier: RLS')
  const end = source.indexOf('// ── Optional tier: ONE paid message')
  assert.ok(start > 0 && end > start, 'RLS section markers not found')
  const section = source.slice(start, end)
  assert.doesNotMatch(section, /method:\s*['"`](POST|PUT|PATCH|DELETE)/i)
  assert.doesNotMatch(section, /rpc\//)
  assert.doesNotMatch(section, /\bbody:/)
})
