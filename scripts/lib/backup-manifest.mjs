// Shared helpers for scripts/staging-backup.mjs and
// scripts/staging-backup-verify.mjs: SHA-256 integrity manifest and safe
// path rules. No network, no database.

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MANIFEST_NAME = 'manifest.json'

/** What a logical backup of the `public` schema does NOT cover — written into every manifest. */
export const NOT_COVERED = [
  'Esquema auth completo (sesiones, identidades, factores MFA, configuración de GoTrue): solo se copian los DATOS de auth.users, como referencia.',
  'Storage: archivos subidos a buckets (la base de datos solo guarda sus metadatos).',
  'Configuración del proyecto Supabase: claves de API, ajustes de Auth (URLs de redirección, SMTP, proveedores), dominios, límites del plan.',
  'Otros esquemas gestionados por Supabase (storage, realtime, vault, extensions, cron, net).',
  'Variables de entorno de Railway y Vercel.',
  'server/data/sessions.json del backend en Railway (conversaciones que se envían a Claude).',
  'Datos escritos DESPUÉS de la hora de la copia.',
]

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** True when `child` is `parent` itself or lies inside it (after resolving symlinks where possible). */
export function isInside(child, parent) {
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const c = real(child).toLowerCase()
  const p = real(parent).toLowerCase()
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

export function writeManifest(dir, data) {
  const files = data.files.map((name) => {
    const full = path.join(dir, name)
    return { name, bytes: statSync(full).size, sha256: sha256File(full) }
  })
  const manifest = { ...data, files, notCovered: NOT_COVERED }
  // 'wx': never overwrite an existing manifest.
  writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  return manifest
}

export function readManifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'))
}

/** Re-hashes every file listed in the manifest. Returns the list of problems (empty = intact). */
export function checkIntegrity(dir, manifest) {
  const problems = []
  for (const file of manifest.files ?? []) {
    const full = path.join(dir, file.name)
    let bytes
    try {
      bytes = statSync(full).size
    } catch {
      problems.push(`${file.name}: no existe`)
      continue
    }
    if (bytes !== file.bytes) problems.push(`${file.name}: tamaño ${bytes} ≠ ${file.bytes}`)
    else if (sha256File(full) !== file.sha256) problems.push(`${file.name}: SHA-256 no coincide`)
  }
  if (!manifest.files?.length) problems.push('el manifiesto no lista ningún archivo')
  return problems
}
