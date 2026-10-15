#!/usr/bin/env node
// Logical backup of the Supabase STAGING database (schema `public` + the data
// of auth.users for reference), with strict identity checks, an integrity
// manifest and row counts. See REPORTE_PLAN_BACKUP_STAGING.txt.
//
// SAFE BY DEFAULT:
//   * Without STAGING_BACKUP_RUN=1 it only CHECKS and prints the plan (dry
//     run): it never connects to the database.
//   * Refuses unless STAGING_BACKUP_CONFIRM=staging.
//   * Identity: the project ref must match the one the STAGING frontend
//     bundle uses (fetched live), must not be listed in STAGING_FORBIDDEN_REFS
//     (put production refs there) and must not be the ref of the local .env
//     (which may point to production) unless explicitly allowed.
//   * The database password is read ONLY from the PGPASSWORD environment
//     variable — never from arguments, never printed, never written.
//   * Every query runs with default_transaction_read_only=on; pg_dump only reads.
//   * Output goes to a NEW timestamped folder inside BACKUP_DIR, which must be
//     outside this repository. Nothing is ever overwritten or deleted.
//   * Uses pg_dump/psql 17 from the local Supabase Postgres Docker image —
//     nothing to install.
//
// Usage (PowerShell; values from the STAGING project only):
//   $sec = Read-Host -AsSecureString "Contraseña BD staging"
//   $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
//   $env:STAGING_BACKUP_CONFIRM = 'staging'
//   $env:STAGING_SUPABASE_REF = '<ref de 20 caracteres de staging>'
//   $env:STAGING_POOLER_HOST = 'aws-0-<región>.pooler.supabase.com'
//   $env:STAGING_FRONTEND_URL = 'https://<frontend-staging>.vercel.app'
//   $env:STAGING_FORBIDDEN_REFS = '<ref de producción>'
//   $env:BACKUP_DIR = 'D:\Backups\maastac-staging'
//   npm run backup:staging                 # dry run: checks + plan
//   $env:STAGING_BACKUP_RUN = '1'; npm run backup:staging   # real backup
//   Remove-Item Env:PGPASSWORD
//
// Exit codes: 0 OK · 1 a step failed · 2 refused (configuration/safety).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInside, writeManifest } from './lib/backup-manifest.mjs'

const env = process.env
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = env.STAGING_BACKUP_IMAGE || 'public.ecr.aws/supabase/postgres:17.11.0.004'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function refuse(message) {
  console.error(`✖ No se ejecuta: ${message}`)
  process.exit(2)
}
const mask = (ref) => `${ref.slice(0, 4)}…${ref.slice(-2)}`
const list = (value) => (value ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)

// ── 1. Configuration and identity (no database access) ────────────────────
if (env.STAGING_BACKUP_CONFIRM !== 'staging') refuse('define STAGING_BACKUP_CONFIRM=staging para confirmar el destino.')

const ref = (env.STAGING_SUPABASE_REF ?? '').trim().toLowerCase()
if (!/^[a-z0-9]{20}$/.test(ref)) refuse('STAGING_SUPABASE_REF debe ser la referencia de 20 caracteres del proyecto de STAGING.')
if (list(env.STAGING_FORBIDDEN_REFS).includes(ref)) refuse(`la referencia ${mask(ref)} está en STAGING_FORBIDDEN_REFS (producción).`)

const poolerHost = (env.STAGING_POOLER_HOST ?? '').trim().toLowerCase()
if (!/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(poolerHost)) {
  refuse('STAGING_POOLER_HOST debe ser el host del "Session pooler" (aws-N-<región>.pooler.supabase.com).')
}

const localEnvRef = (() => {
  try {
    const match = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8').match(/^\s*VITE_SUPABASE_URL\s*=\s*["']?https:\/\/([a-z0-9]{20})\.supabase\.co/m)
    return match?.[1] ?? null
  } catch {
    return null
  }
})()
if (localEnvRef === ref && env.STAGING_BACKUP_ALLOW_LOCAL_ENV_REF !== 'yes') {
  refuse(`la referencia ${mask(ref)} es la del .env local, que podría ser producción. Si estás SEGURO de que es staging, define STAGING_BACKUP_ALLOW_LOCAL_ENV_REF=yes.`)
}

let frontend
try {
  frontend = new URL(env.STAGING_FRONTEND_URL ?? '')
} catch {
  refuse('falta STAGING_FRONTEND_URL (URL del frontend de STAGING).')
}
if (frontend.protocol !== 'https:' && !LOOPBACK.has(frontend.hostname)) refuse('STAGING_FRONTEND_URL debe usar https.')
if (!frontend.hostname.includes('staging') && !LOOPBACK.has(frontend.hostname) && !list(env.STAGING_ALLOWED_HOSTS).includes(frontend.hostname)) {
  refuse(`STAGING_FRONTEND_URL (${frontend.hostname}) no parece de staging.`)
}

const backupRoot = env.BACKUP_DIR ? path.resolve(env.BACKUP_DIR) : ''
if (!backupRoot || !path.isAbsolute(env.BACKUP_DIR)) refuse('BACKUP_DIR debe ser una ruta absoluta fuera del repositorio.')
if (isInside(backupRoot, REPO_ROOT) || isInside(REPO_ROOT, backupRoot)) refuse('BACKUP_DIR no puede estar dentro del repositorio (la copia contiene datos personales).')

// Identity check against the LIVE staging frontend: its bundle must use exactly this project.
async function bundleRefs() {
  const html = await (await fetch(frontend.origin + '/', { signal: AbortSignal.timeout(15000) })).text()
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => new URL(m[1], frontend.origin + '/').href)
  const js = (await Promise.all(scripts.map(async (src) => (await fetch(src, { signal: AbortSignal.timeout(15000) })).text()))).join('\n')
  return [...new Set([...js.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)].map((m) => m[1]))]
}
let refs
try {
  refs = await bundleRefs()
} catch (error) {
  refuse(`no se pudo leer el frontend de staging para verificar la identidad (${error instanceof Error ? error.message : error}).`)
}
if (refs.length !== 1) refuse(`el bundle del frontend de staging contiene ${refs.length} proyectos Supabase; se esperaba exactamente 1.`)
if (refs[0] !== ref) refuse(`STAGING_SUPABASE_REF (${mask(ref)}) NO coincide con el proyecto que usa el frontend de staging (${mask(refs[0])}).`)

const run = env.STAGING_BACKUP_RUN === '1'

// Local prerequisites (no network): Docker running, the pg_dump image present,
// enough free disk. Warnings in the dry run; blocking for the real run, and
// always checked BEFORE any folder is created.
const MIN_FREE_BYTES = 1024 ** 3 // 1 GiB
function localPreflight() {
  const problems = []
  const server = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
  if (server.error || server.status !== 0) problems.push('Docker no está disponible o no está en marcha')
  else if (spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status !== 0) problems.push(`falta la imagen ${IMAGE} (docker pull, con tu autorización)`)
  let probe = backupRoot
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe)
  try {
    const stats = statfsSync(probe)
    const free = stats.bavail * stats.bsize
    if (free < MIN_FREE_BYTES) problems.push(`poco espacio libre en ${probe} (${Math.round(free / 1024 ** 2)} MiB; mínimo 1 GiB)`)
  } catch {
    problems.push(`no se pudo comprobar el espacio libre en ${probe}`)
  }
  return problems
}
const preflightProblems = localPreflight()
const conninfo = `host=${poolerHost} port=5432 dbname=postgres user=postgres.${ref} sslmode=require connect_timeout=15`
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(backupRoot, `staging-${ref.slice(0, 4)}-${stamp}`)

console.log('✔ Identidad verificada:')
console.log(`   proyecto ${mask(ref)} = el que usa ${frontend.hostname}; no está en la lista de producción; no es el del .env local`)
console.log(`   conexión: Session pooler ${poolerHost}:5432, usuario postgres.${mask(ref)}, solo lectura`)
console.log(`   destino: ${outDir}`)

if (!run) {
  if (!env.PGPASSWORD) console.log('   (aviso: PGPASSWORD no está definida; será obligatoria para la copia real)')
  if (preflightProblems.length) for (const p of preflightProblems) console.log(`   ⚠ requisito local: ${p}`)
  else console.log('✔ Requisitos locales: Docker en marcha, imagen de pg_dump presente, espacio libre suficiente')
  console.log('\nModo comprobación (dry run): no se ha conectado a la base de datos.')
  console.log('Para la copia real: define STAGING_BACKUP_RUN=1 y vuelve a ejecutar.')
  process.exit(0)
}

// ── 2. Real backup ─────────────────────────────────────────────────────────
if (!env.PGPASSWORD) refuse('falta PGPASSWORD (contraseña de la base de datos de STAGING, pedida con Read-Host).')
if (preflightProblems.length) refuse(`requisitos locales: ${preflightProblems.join('; ')}.`)
if (existsSync(outDir)) refuse(`ya existe ${outDir}; no se sobrescribe nada.`)
mkdirSync(outDir, { recursive: true })

const dockerBase = ['run', '--rm', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', '-v', `${outDir}:/backup`]
function docker(entrypoint, args) {
  const result = spawnSync('docker', [...dockerBase, '--entrypoint', entrypoint, IMAGE, ...args], { encoding: 'utf8', env, maxBuffer: 64 << 20 })
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}
function fail(step, result) {
  // stderr from pg tools never contains the password (it is only in the environment).
  console.error(`✖ ${step} falló: ${result.err.split('\n').slice(0, 3).join(' | ')}`)
  console.error(`  La carpeta ${outDir} se conserva tal cual para revisión; no se borra nada.`)
  process.exit(1)
}

// 2a. Live identity + schema sanity (read-only).
const identity = docker('psql', [
  conninfo,
  '-X',
  '-At',
  '-c',
  "select current_database() || '|' || current_setting('server_version_num') || '|' || (select count(*) from pg_tables where schemaname = 'public' and tablename in ('organizations', 'leads', 'chat_configuration', 'organization_quotas'))",
])
if (!identity.ok) fail('Conexión de solo lectura', identity)
const [database, serverVersionNum, maastacTables] = identity.out.split('|')
if (database !== 'postgres' || maastacTables !== '4') {
  console.error(`✖ La base de datos no parece MAASTAC staging (base=${database}, tablas esperadas encontradas=${maastacTables}/4). No se copia nada.`)
  process.exit(1)
}
if (Number(serverVersionNum) >= 180000) {
  console.error('✖ El servidor es PostgreSQL 18+; pg_dump 17 no puede volcarlo. Usa una imagen con pg_dump 18 (STAGING_BACKUP_IMAGE).')
  process.exit(1)
}

// 2b. Exact row counts of every public table (reference for the restore test).
const counts = docker('psql', [
  conninfo,
  '-X',
  '-At',
  '-c',
  "select coalesce(json_object_agg(table_name, n order by table_name), '{}') from (select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::bigint as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') t",
])
if (!counts.ok) fail('Recuento de filas', counts)
writeFileSync(path.join(outDir, 'counts.json'), JSON.stringify(JSON.parse(counts.out), null, 2), { flag: 'wx' })

// 2c. Dumps.
const publicDump = docker('pg_dump', [conninfo, '--schema=public', '--format=custom', '--no-owner', '--no-privileges', '--file=/backup/public.dump'])
if (!publicDump.ok) fail('pg_dump del esquema public', publicDump)
const authDump = docker('pg_dump', [conninfo, '--data-only', '--table=auth.users', '--format=custom', '--file=/backup/auth-users.dump'])
if (!authDump.ok) fail('pg_dump de auth.users', authDump)

// 2d. Each dump must be readable (table of contents).
for (const file of ['public.dump', 'auth-users.dump']) {
  const toc = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${outDir}:/backup:ro`, '--entrypoint', 'pg_restore', IMAGE, '--list', `/backup/${file}`], { encoding: 'utf8' })
  if (toc.status !== 0) fail(`Lectura de ${file}`, { err: toc.stderr ?? '' })
}

const manifest = writeManifest(outDir, {
  kind: 'maastac-staging-logical-backup',
  createdAt: new Date().toISOString(),
  project: { ref, poolerHost, verifiedAgainst: frontend.origin },
  serverVersionNum: Number(serverVersionNum),
  tool: IMAGE,
  counts: JSON.parse(counts.out),
  files: ['public.dump', 'auth-users.dump', 'counts.json'],
})
console.log(`\n✔ Copia creada en ${outDir}`)
for (const f of manifest.files) console.log(`   ${f.name}  ${f.bytes} bytes  sha256 ${f.sha256.slice(0, 16)}…`)
console.log(`   ${Object.keys(manifest.counts).length} tablas contadas. Siguiente paso: npm run backup:staging:verify -- "${outDir}"`)
console.log('   ⚠ Contiene datos personales: custódiala y no la subas a ningún servicio.')
