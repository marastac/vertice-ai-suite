// Tests for scripts/staging-backup.mjs: every safety refusal, and the dry run
// against a LOCAL mock "staging frontend" (127.0.0.1). Never connects to any
// database: docker is made unreachable (PATH limited to Node itself), so any
// attempt to run it would fail the test. Node's built-in runner via the
// backend's tsx (included in `npm run test:all:safe`).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const SCRIPT = path.resolve('scripts', 'staging-backup.mjs')
const STAGING_REF = 'abcdefghijklmnopqrst'
const OTHER_REF = 'zyxwvutsrqponmlkjihg'
const SECRET = 'super-secret-db-password-never-printed'
let bundleRefs = [STAGING_REF]
let frontOrigin = ''
const server = createServer((req, res) => {
  if (req.url === '/assets/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' })
    return res.end(bundleRefs.map((r) => `const u="https://${r}.supabase.co";`).join(''))
  }
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<div id="root"></div><script type="module" src="/assets/app.js"></script>')
})

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  frontOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    // Only Node's own directory: `docker` cannot be found from here.
    PATH: path.dirname(process.execPath),
    SystemRoot: process.env.SystemRoot ?? '',
    STAGING_BACKUP_CONFIRM: 'staging',
    STAGING_SUPABASE_REF: STAGING_REF,
    STAGING_POOLER_HOST: 'aws-0-us-east-1.pooler.supabase.com',
    STAGING_FRONTEND_URL: frontOrigin,
    STAGING_FORBIDDEN_REFS: OTHER_REF,
    BACKUP_DIR: path.join(os.tmpdir(), 'maastac-backup-test-never-created'),
    PGPASSWORD: SECRET,
    ...extra,
  }
}

function run(e: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: e })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('close', (code) => resolve({ code, output }))
  })
}

async function refuses(extra: Record<string, string>, pattern: RegExp) {
  const { code, output } = await run(env(extra))
  assert.equal(code, 2, output)
  assert.match(output, pattern)
  assert.ok(!output.includes(SECRET), 'printed the password')
}

test('refuses without STAGING_BACKUP_CONFIRM=staging', () => refuses({ STAGING_BACKUP_CONFIRM: '' }, /STAGING_BACKUP_CONFIRM/))
test('refuses a malformed project ref', () => refuses({ STAGING_SUPABASE_REF: 'prod' }, /20 caracteres/))
test('refuses a ref listed as production', () => refuses({ STAGING_SUPABASE_REF: OTHER_REF }, /STAGING_FORBIDDEN_REFS/))
test('refuses anything but the Session pooler host', async () => {
  for (const host of ['db.abcdefghijklmnopqrst.supabase.co', 'evil.example.com', 'aws-0-x.pooler.supabase.com.evil.com']) {
    await refuses({ STAGING_POOLER_HOST: host }, /Session pooler/)
  }
})
test('refuses a backup folder inside the repository or a relative one', async () => {
  await refuses({ BACKUP_DIR: path.resolve('backups') }, /dentro del repositorio/)
  await refuses({ BACKUP_DIR: 'backups' }, /ruta absoluta/)
})
test('refuses a frontend that does not look like staging', () => refuses({ STAGING_FRONTEND_URL: 'https://app.maastac.com' }, /no parece de staging/))
test('IDENTITY: refuses when the staging frontend uses a DIFFERENT Supabase project', async () => {
  bundleRefs = [OTHER_REF]
  try {
    await refuses({ STAGING_FORBIDDEN_REFS: '' }, /NO coincide/)
  } finally {
    bundleRefs = [STAGING_REF]
  }
})
test('IDENTITY: refuses an ambiguous bundle with more than one Supabase project', async () => {
  bundleRefs = [STAGING_REF, OTHER_REF]
  try {
    await refuses({ STAGING_FORBIDDEN_REFS: '' }, /exactamente 1/)
  } finally {
    bundleRefs = [STAGING_REF]
  }
})
test('IDENTITY: refuses the ref of the local .env (possibly production) unless explicitly allowed', async (t) => {
  let localRef: string | undefined
  try {
    localRef = readFileSync('.env', 'utf8').match(/VITE_SUPABASE_URL\s*=\s*["']?https:\/\/([a-z0-9]{20})\.supabase\.co/)?.[1]
  } catch {
    // no local .env
  }
  if (!localRef) return t.skip('sin .env local con VITE_SUPABASE_URL')
  bundleRefs = [localRef]
  try {
    await refuses({ STAGING_SUPABASE_REF: localRef, STAGING_FORBIDDEN_REFS: '' }, /\.env local/)
  } finally {
    bundleRefs = [STAGING_REF]
  }
})
test('the real run refuses without PGPASSWORD (and never asks for it on the command line)', () =>
  refuses({ STAGING_BACKUP_RUN: '1', PGPASSWORD: '' }, /PGPASSWORD/))

test('DRY RUN with a verified identity: exit 0, never connects, never prints the password', async () => {
  const { code, output } = await run(env())
  assert.equal(code, 0, output)
  assert.match(output, /Identidad verificada/)
  assert.match(output, /no se ha conectado a la base de datos/)
  assert.ok(!output.includes(SECRET))
  assert.ok(!output.includes(STAGING_REF), 'printed the full project ref')
})

test('PREFLIGHT: without Docker, the dry run warns and the real run refuses BEFORE creating any folder', async () => {
  const dryRun = await run(env())
  assert.equal(dryRun.code, 0, dryRun.output)
  assert.match(dryRun.output, /requisito local: Docker no está disponible/)

  const backupDir = path.join(os.tmpdir(), `maastac-backup-test-${process.pid}-never-created`)
  const real = await run(env({ STAGING_BACKUP_RUN: '1', BACKUP_DIR: backupDir }))
  assert.equal(real.code, 2, real.output)
  assert.match(real.output, /requisitos locales: Docker no está disponible/)
  assert.ok(!existsSync(backupDir), 'created the backup folder despite refusing')
  assert.ok(!real.output.includes(SECRET))
})
