import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSessionRepository } from '../src/repositories/session-repository.js'
import type { StoredSession } from '../src/repositories/session-repository.js'

// Durability of server/data/sessions.json (Fase 3). Every test works in its
// OWN temporary directory under the OS temp folder — never the real data dir.

const TEMP_PREFIX = 'maastac-sessions-test-'
const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  created.push(dir)
  return dir
}

afterEach(() => {
  // Removes only directories this file created: inside the OS temp folder
  // and carrying this file's own prefix.
  const tmpRoot = realpathSync(os.tmpdir())
  for (const dir of created.splice(0)) {
    const real = realpathSync(dir)
    if (real.startsWith(tmpRoot + path.sep) && path.basename(real).startsWith(TEMP_PREFIX)) {
      rmSync(real, { recursive: true, force: true })
    }
  }
})

const CONFIG = { assistantName: 'Asistente', welcomeMessage: 'Hola', tone: 'friendly' } as unknown as StoredSession['config']
const RESOLVED = { status: 'resolved' as const, organizationId: '11111111-1111-4111-8111-111111111111' }

function readStored(dir: string): [string, StoredSession][] {
  return JSON.parse(readFileSync(path.join(dir, 'sessions.json'), 'utf8'))
}

describe('FileSessionRepository — durability', () => {
  it('persists every change and a new instance (a restart) reads it back', () => {
    const dir = tempDir()
    const repo = new FileSessionRepository({ dataDir: dir })
    const session = repo.create('org-a', CONFIG, RESOLVED, 'server')
    repo.appendTurn(session.id, { role: 'user', content: 'Hola' })
    repo.appendTurn(session.id, { role: 'assistant', content: '¿En qué te ayudo?' })

    const reloaded = new FileSessionRepository({ dataDir: dir })
    expect(reloaded.get(session.id)?.history.map((t) => t.content)).toEqual(['Hola', '¿En qué te ayudo?'])
  })

  it('writes atomically: no temporary file is left behind and the file is always complete JSON', () => {
    const dir = tempDir()
    const repo = new FileSessionRepository({ dataDir: dir })
    for (let i = 0; i < 20; i++) repo.create(`org-${i}`, CONFIG, RESOLVED)
    expect(readStored(dir)).toHaveLength(20)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('a CORRUPT sessions.json is preserved aside, never overwritten by the next write', () => {
    const dir = tempDir()
    const garbage = '[["truncated-by-a-crash", {"id": "x", "history": [{"role": "user", "cont'
    writeFileSync(path.join(dir, 'sessions.json'), garbage)

    const repo = new FileSessionRepository({ dataDir: dir })
    expect(repo.list()).toEqual([])
    repo.create('org-a', CONFIG, RESOLVED)

    const preserved = readdirSync(dir).filter((name) => name.startsWith('sessions.corrupt-'))
    expect(preserved).toHaveLength(1)
    expect(readFileSync(path.join(dir, preserved[0]), 'utf8')).toBe(garbage)
    expect(readStored(dir)).toHaveLength(1)
  })

  it('restore() adds missing sessions, replaces only with a strictly newer copy, and does not notify the listener', () => {
    const dir = tempDir()
    const repo = new FileSessionRepository({ dataDir: dir })
    const listener = vi.fn()
    const local = repo.create('org-a', CONFIG, RESOLVED)
    repo.setChangeListener(listener)

    const older = { ...structuredClone(local), history: [{ role: 'user' as const, content: 'viejo' }], updatedAt: '2000-01-01T00:00:00.000Z' }
    const missing = { ...structuredClone(local), id: '22222222-2222-4222-8222-222222222222', updatedAt: '2030-01-01T00:00:00.000Z' }

    expect(repo.restore([older, missing])).toBe(1)
    expect(repo.get(local.id)?.history).toEqual([])
    expect(repo.get(missing.id)).toBeDefined()
    expect(listener).not.toHaveBeenCalled()
    expect(new FileSessionRepository({ dataDir: dir }).get(missing.id)).toBeDefined()
  })

  it('notifies the change listener after every mutation, and a failing listener never breaks the chat', () => {
    const dir = tempDir()
    const repo = new FileSessionRepository({ dataDir: dir })
    const seen: string[] = []
    repo.setChangeListener((session) => {
      seen.push(`${session.id}:${session.history.length}`)
      throw new Error('durable store down')
    })
    const session = repo.create('org-a', CONFIG, RESOLVED)
    expect(() => repo.appendTurn(session.id, { role: 'user', content: 'Hola' })).not.toThrow()
    repo.setQualification(session.id, { score: 10 } as never)
    expect(seen).toEqual([`${session.id}:0`, `${session.id}:1`, `${session.id}:1`])
    expect(existsSync(path.join(dir, 'sessions.json'))).toBe(true)
  })

  it('without a listener (the default), behavior is exactly the plain file store', () => {
    const dir = tempDir()
    const repo = new FileSessionRepository({ dataDir: dir })
    const session = repo.create('org-a', CONFIG, RESOLVED)
    repo.appendTurn(session.id, { role: 'user', content: 'x' })
    expect(readStored(dir)[0][1].history).toEqual([{ role: 'user', content: 'x' }])
  })
})
