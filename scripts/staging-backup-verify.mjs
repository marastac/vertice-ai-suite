#!/usr/bin/env node
// Verifies a backup made by scripts/staging-backup.mjs WITHOUT touching any
// real service:
//   1. SHA-256 and size of every file against manifest.json;
//   2. a test restore into a DISPOSABLE Postgres container with NO network
//      (--network none), with the backup folder mounted READ-ONLY;
//   3. row counts of every public table compared with counts.json.
// The backup folder is never modified or deleted. The only thing removed at
// the end is the container this script created itself (fixed prefix
// "maastac-restore-"); set KEEP_RESTORE_CONTAINER=1 to keep it for inspection.
//
// Usage: npm run backup:staging:verify -- "D:\Backups\maastac-staging\staging-xxxx-<fecha>"
// Exit codes: 0 verified · 1 a check failed · 2 refused (bad input).

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { checkIntegrity, readManifest } from './lib/backup-manifest.mjs'

const IMAGE = process.env.STAGING_BACKUP_IMAGE || 'public.ecr.aws/supabase/postgres:17.11.0.004'
const dir = process.argv[2] ? path.resolve(process.argv[2]) : ''
const refuse = (m) => {
  console.error(`✖ No se ejecuta: ${m}`)
  process.exit(2)
}
if (!dir || !existsSync(path.join(dir, 'manifest.json'))) refuse('indica la carpeta de una copia (debe contener manifest.json).')

const manifest = readManifest(dir)
if (manifest.kind !== 'maastac-staging-logical-backup') refuse('manifest.json no es de una copia de MAASTAC staging.')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })

// 1. Integrity.
const problems = checkIntegrity(dir, manifest)
check('Integridad SHA-256 y tamaños', problems.length === 0, problems.join('; '))

// 2. Restore test.
const container = `maastac-restore-${randomBytes(4).toString('hex')}`
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const docker = (args, input) => spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 << 20 })
const psql = (sql) => docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-At', '-v', 'ON_ERROR_STOP=1'], sql)
let restored = false
if (problems.length === 0) {
  const started = docker(['run', '-d', '--name', container, '--network', 'none', '-e', 'POSTGRES_PASSWORD=solo-local', '-v', `${dir}:/backup:ro`, IMAGE])
  if (started.status !== 0) {
    check('Contenedor de restauración (sin red)', false, started.stderr.trim())
  } else {
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      ready = docker(['exec', container, 'pg_isready', '-U', 'postgres', '-h', 'localhost']).status === 0
      if (!ready) sleep(2000)
    }
    sleep(6000)
    check('Contenedor de restauración (sin red)', ready)

    // auth.users first: organization_members references it, so without these
    // rows the public restore fails its foreign keys.
    //
    // The plain Postgres image ships auth.users in its INITIAL GoTrue shape;
    // a real Supabase project has the current one (more columns, e.g.
    // email_confirmed_at, phone, is_anonymous). The dump is data-only, so its
    // COPY header is the source of truth: every column it carries that this
    // TEST container lacks is added as text (only here — the backup and any
    // real project are never touched). Restoring into a real Supabase project
    // needs none of this: its auth.users already has the current shape.
    const header = docker([
      'exec',
      container,
      'bash',
      '-c',
      "pg_restore -f - /backup/auth-users.dump | grep -m1 '^COPY auth.users ' | sed -E 's/^COPY auth\\.users \\((.*)\\) FROM stdin;$/\\1/'",
    ])
    const dumpColumns = header.status === 0 ? header.stdout.trim().split(',').map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean) : []
    const imageColumns = new Set(
      psql("select column_name from information_schema.columns where table_schema = 'auth' and table_name = 'users'").stdout.trim().split('\n'),
    )
    const missing = dumpColumns.filter((c) => !imageColumns.has(c))
    const unsafe = missing.filter((c) => !/^[a-z_][a-z0-9_]{0,62}$/.test(c))
    let adapted = unsafe.length === 0 && dumpColumns.length > 0
    if (adapted && missing.length > 0) {
      const ddl = missing.map((c) => `alter table auth.users add column if not exists ${c} text;`).join('\n')
      adapted = docker(['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], ddl).status === 0
    }
    check(
      'Contenedor de prueba adaptado a la versión de auth del volcado',
      adapted,
      dumpColumns.length === 0 ? 'no se pudo leer la cabecera de auth.users' : unsafe.length ? `nombres de columna no válidos: ${unsafe.join(', ')}` : `${missing.length} columna(s) añadida(s) solo en el contenedor`,
    )

    // auth tables belong to supabase_admin in the Supabase image.
    const auth = docker(['exec', container, 'pg_restore', '-U', 'supabase_admin', '-d', 'postgres', '--data-only', '--disable-triggers', '/backup/auth-users.dump'])
    const dumpedUsers = Number(
      docker(['exec', container, 'bash', '-c', "pg_restore -f - /backup/auth-users.dump | awk '/^COPY auth.users /{f=1;next} /^\\\\\\.$/{f=0} f' | wc -l"]).stdout.trim(),
    )
    const restoredUsers = Number(psql('select count(*) from auth.users').stdout.trim())
    check(
      'auth.users restaurado: mismas filas que el volcado',
      auth.status === 0 && restoredUsers === dumpedUsers,
      auth.status === 0 ? `${restoredUsers}/${dumpedUsers} filas` : (auth.stderr.split('\n').find((l) => l.includes('ERROR')) ?? 'error'),
    )

    // The dump includes CREATE SCHEMA public, which already exists in any
    // Postgres: that one TOC entry is filtered out (inside the container,
    // /tmp) instead of dropping anything.
    const pub = docker([
      'exec',
      container,
      'bash',
      '-c',
      "pg_restore -l /backup/public.dump | grep -v -E ' SCHEMA - public | COMMENT - SCHEMA public ' > /tmp/public.toc && pg_restore -U postgres -d postgres --no-owner --no-privileges --exit-on-error -L /tmp/public.toc /backup/public.dump",
    ])
    restored = pub.status === 0
    check('Esquema public restaurado completo (tablas, datos, índices, restricciones)', restored, restored ? '' : pub.stderr.split('\n').filter((l) => l.includes('error') || l.includes('ERROR')).slice(0, 2).join(' | '))

    // 3. Counts.
    if (restored) {
      const got = psql(
        "select coalesce(json_object_agg(table_name, n order by table_name), '{}') from (select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::bigint as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') t",
      )
      const actual = got.status === 0 ? JSON.parse(got.stdout.trim()) : {}
      const mismatches = Object.entries(manifest.counts ?? {}).filter(([table, n]) => actual[table] !== n).map(([table, n]) => `${table}: ${actual[table] ?? 'falta'} ≠ ${n}`)
      check(`Recuentos de ${Object.keys(manifest.counts ?? {}).length} tablas idénticos a los del momento de la copia`, got.status === 0 && mismatches.length === 0, mismatches.slice(0, 5).join('; '))
    }
  }
}

if (process.env.KEEP_RESTORE_CONTAINER === '1') {
  console.log(`(contenedor ${container} conservado para inspección; elimínalo con: docker rm -f ${container})`)
} else if (/^maastac-restore-[0-9a-f]{8}$/.test(container)) {
  docker(['rm', '-f', container])
}

console.log(`\n══════════ verificación de copia — ${path.basename(dir)} ══════════`)
for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
console.log('\nNo cubierto por esta copia:')
for (const item of manifest.notCovered ?? []) console.log(`  - ${item}`)
const failed = results.filter((r) => !r.ok).length
console.log(`\nRESULTADO: ${failed === 0 ? 'COPIA VERIFICADA' : `${failed} comprobación(es) fallida(s)`}`)
process.exit(failed === 0 ? 0 : 1)
