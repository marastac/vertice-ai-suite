import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Regression guard: every environment variable the backend reads must be
// documented in server/.env.example (set or commented out), so whoever
// configures staging/production from that file can't miss one. Six variables
// (HubSpot, FRONTEND_URL, CHAT_MAX_USER_MESSAGES) were once missing.
// Static read of the source — no env, no network.

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

function variablesReadByCode(): Set<string> {
  const names = new Set<string>()
  for (const file of sourceFiles(path.join(serverDir, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      names.add(match[1])
    }
  }
  return names
}

function variablesDocumented(): Set<string> {
  const names = new Set<string>()
  const content = readFileSync(path.join(serverDir, '.env.example'), 'utf8')
  for (const match of content.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
    names.add(match[1])
  }
  return names
}

describe('server/.env.example', () => {
  it('documents every process.env variable the backend reads', () => {
    const documented = variablesDocumented()
    const missing = [...variablesReadByCode()].filter((name) => !documented.has(name)).sort()
    expect(missing).toEqual([])
  })

  it('the scan itself works (finds the core variables) — guards against a silently empty check', () => {
    const read = variablesReadByCode()
    for (const name of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'CHAT_QUOTAS_ENABLED', 'CORS_ORIGIN']) {
      expect(read.has(name)).toBe(true)
    }
  })

  it('ships no secret values: secret-bearing variables are empty or commented out', () => {
    const content = readFileSync(path.join(serverDir, '.env.example'), 'utf8')
    for (const name of ['ANTHROPIC_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_TOKEN_ENCRYPTION_KEY']) {
      const line = content.split(/\r?\n/).find((l) => new RegExp(`^\\s*#?\\s*${name}=`).test(l))
      expect(line, `${name} must be documented`).toBeDefined()
      expect(line!.replace(/^\s*#?\s*[A-Z0-9_]+=/, '').trim(), `${name} must have no value`).toBe('')
    }
  })

  it('keeps monthly quotas OFF by default', () => {
    const content = readFileSync(path.join(serverDir, '.env.example'), 'utf8')
    expect(content).toMatch(/^CHAT_QUOTAS_ENABLED=false$/m)
  })
})
