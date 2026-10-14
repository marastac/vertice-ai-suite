#!/usr/bin/env node
// Fails if a production frontend build ships internal/developer details.
//
// The public chat (/c/:orgSlug) is seen by our customers' visitors. Its
// developer-only hints ("npm run dev:server", "server/.env", …) must be
// tree-shaken out of production — a refactor once made them ship again
// (unused, but readable by anyone inspecting the JS). This catches that.
//
// Usage (after a production build; no dependencies, Node only):
//   npm run build                                  # or: npx vite build --outDir <dir>
//   node scripts/check-production-bundle.mjs [distDir]   (default: dist)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const FORBIDDEN = [
  'npm run dev:server',
  'server/.env',
  'Si eres parte del equipo',
  'sk-ant-', // an Anthropic API key prefix must never be in the bundle
  'service_role',
]

// What the production copy SHOULD contain — proves we scanned a real build.
const EXPECTED = ['No pudimos conectar con el asistente en este momento']

const distDir = path.resolve(process.argv[2] ?? 'dist')
const assetsDir = path.join(distDir, 'assets')

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? jsFiles(full) : full.endsWith('.js') ? [full] : []
  })
}

let files
try {
  files = jsFiles(assetsDir)
} catch {
  console.error(`✖ No build found at ${assetsDir}. Run a production build first.`)
  process.exit(2)
}
if (files.length === 0) {
  console.error(`✖ No .js files in ${assetsDir}.`)
  process.exit(2)
}

const bundle = files.map((file) => readFileSync(file, 'utf8')).join('\n')
const leaked = FORBIDDEN.filter((needle) => bundle.includes(needle))
const missing = EXPECTED.filter((needle) => !bundle.includes(needle))

for (const needle of leaked) console.error(`✖ Production bundle contains forbidden text: "${needle}"`)
for (const needle of missing) console.error(`✖ Production bundle is missing expected text: "${needle}" (not a production build?)`)

if (leaked.length > 0 || missing.length > 0) process.exit(1)
console.log(`✔ Production bundle OK (${files.length} JS files scanned, ${FORBIDDEN.length} forbidden patterns absent).`)
