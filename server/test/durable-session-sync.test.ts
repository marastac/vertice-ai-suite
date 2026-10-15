import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSessionRepository } from '../src/repositories/session-repository.js'
import type { StoredSession } from '../src/repositories/session-repository.js'
import { createDurableSessionSync, organizationIdOf } from '../src/services/durable-session-sync.js'
import type { SessionSnapshot, SessionSnapshotStore } from '../src/services/durable-session-sync.js'

// Opt-in durable copy of chat sessions (CHAT_SESSION_STORE=postgres). The
// fake store below enforces the SAME rules as save_backend_chat_session()
// in SQL (only a strictly newer version applies; a session never moves to
// another organization) — the SQL itself is tested in
// supabase/tests-backend-chat-sessions.sql against a disposable Postgres.

const TEMP_PREFIX = 'maastac-durable-test-'
const created: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  created.push(dir)
  return dir
}
afterEach(() => {
  const tmpRoot = realpathSync(os.tmpdir())
  for (const dir of created.splice(0)) {
    const real = realpathSync(dir)
    if (real.startsWith(tmpRoot + path.sep) && path.basename(real).startsWith(TEMP_PREFIX)) rmSync(real, { recursive: true, force: true })
  }
})

const CONFIG = { assistantName: 'Asistente', welcomeMessage: 'Hola', tone: 'friendly' } as unknown as StoredSession['config']
const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const resolved = (organizationId: string) => ({ status: 'resolved' as const, organizationId })

function fakeStore(options: { delayMs?: (call: number) => number; failOn?: (call: number) => 'error' | 'throw' | null } = {}) {
  const rows = new Map<string, SessionSnapshot>()
  let calls = 0
  const store: SessionSnapshotStore & { rows: typeof rows; saves: SessionSnapshot[] } = {
    rows,
    saves: [],
    async save(snapshot) {
      const call = ++calls
      const delay = options.delayMs?.(call) ?? 0
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const failure = options.failOn?.(call)
      if (failure === 'throw') throw new Error('network down')
      if (failure === 'error') return { ok: false, message: 'database unavailable' }
      store.saves.push(snapshot)
      const current = rows.get(snapshot.id)
      if (current && current.version >= snapshot.version) return { ok: true, data: false }
      if (current?.organizationId && snapshot.organizationId && current.organizationId !== snapshot.organizationId) return { ok: true, data: false }
      rows.set(snapshot.id, { ...structuredClone(snapshot), organizationId: current?.organizationId ?? snapshot.organizationId })
      return { ok: true, data: true }
    },
    async loadRecent() {
      return { ok: true, data: [...rows.values()].map((r) => structuredClone(r)) }
    },
  }
  return store
}

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('durable session sync', () => {
  it('mirrors every change; the stored copy ends identical to the live session', async () => {
    const repo = new FileSessionRepository({ dataDir: tempDir() })
    const store = fakeStore()
    const sync = createDurableSessionSync({ repository: repo, store, logger: silentLogger() })
    sync.start()

    const session = repo.create('org-a', CONFIG, resolved(ORG_A), 'server')
    repo.appendTurn(session.id, { role: 'user', content: 'Hola' })
    repo.appendTurn(session.id, { role: 'assistant', content: 'Bienvenido' })
    await sync.flush()

    expect(store.rows.get(session.id)?.state).toEqual(repo.get(session.id))
    expect(store.rows.get(session.id)?.organizationId).toBe(ORG_A)
    const versions = store.saves.map((s) => s.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('slow, uneven writes are applied in order per session (never an older state last)', async () => {
    const repo = new FileSessionRepository({ dataDir: tempDir() })
    const store = fakeStore({ delayMs: (call) => (call % 2 === 0 ? 30 : 1) })
    const sync = createDurableSessionSync({ repository: repo, store, logger: silentLogger() })
    sync.start()
    const session = repo.create('org-a', CONFIG, resolved(ORG_A))
    for (let i = 0; i < 10; i++) repo.appendTurn(session.id, { role: 'user', content: `m${i}` })
    await sync.flush()
    expect(store.rows.get(session.id)?.state.history).toHaveLength(10)
  })

  it('each snapshot is taken at change time (later edits never leak into an earlier version)', async () => {
    const repo = new FileSessionRepository({ dataDir: tempDir() })
    const store = fakeStore({ delayMs: () => 10 })
    const sync = createDurableSessionSync({ repository: repo, store, logger: silentLogger() })
    sync.start()
    const session = repo.create('org-a', CONFIG, resolved(ORG_A))
    repo.appendTurn(session.id, { role: 'user', content: 'uno' })
    await sync.flush()
    expect(store.saves.map((s) => s.state.history.length)).toEqual([0, 1])
  })

  it('a failing durable store never breaks the conversation, and later changes are still saved', async () => {
    const repo = new FileSessionRepository({ dataDir: tempDir() })
    const store = fakeStore({ failOn: (call) => (call === 1 ? 'throw' : call === 2 ? 'error' : null) })
    const logger = silentLogger()
    const sync = createDurableSessionSync({ repository: repo, store, logger })
    sync.start()
    const session = repo.create('org-a', CONFIG, resolved(ORG_A))
    expect(() => repo.appendTurn(session.id, { role: 'user', content: 'Hola' })).not.toThrow()
    repo.appendTurn(session.id, { role: 'assistant', content: 'Sí' })
    await sync.flush()
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(store.rows.get(session.id)?.state.history).toHaveLength(2)
  })

  it('RECOVERY: after a redeploy that wiped sessions.json, the conversation comes back from the durable copy', async () => {
    const store = fakeStore()
    const before = new FileSessionRepository({ dataDir: tempDir() })
    const syncBefore = createDurableSessionSync({ repository: before, store, logger: silentLogger() })
    syncBefore.start()
    const session = before.create('org-a', CONFIG, resolved(ORG_A), 'server')
    before.appendTurn(session.id, { role: 'user', content: 'Quiero una cotización' })
    await syncBefore.flush()

    const after = new FileSessionRepository({ dataDir: tempDir() }) // empty disk
    expect(after.get(session.id)).toBeUndefined()
    const syncAfter = createDurableSessionSync({ repository: after, store, logger: silentLogger() })
    expect(await syncAfter.hydrate()).toEqual({ restored: 1, ok: true })
    syncAfter.start()
    expect(after.get(session.id)?.history.map((t) => t.content)).toEqual(['Quiero una cotización'])

    // The next change after recovery is NEWER than the recovered version, so it is applied.
    after.appendTurn(session.id, { role: 'assistant', content: 'Claro' })
    await syncAfter.flush()
    expect(store.rows.get(session.id)?.state.history).toHaveLength(2)
  })

  it('a failed recovery never throws: the backend just continues from sessions.json', async () => {
    const repo = new FileSessionRepository({ dataDir: tempDir() })
    const store: SessionSnapshotStore = { save: vi.fn(), loadRecent: vi.fn().mockRejectedValue(new Error('timeout')) }
    const sync = createDurableSessionSync({ repository: repo, store, logger: silentLogger() })
    await expect(sync.hydrate()).resolves.toEqual({ restored: 0, ok: false })
  })

  it('ISOLATION: a session never moves to another organization in the durable copy', async () => {
    const repo = new FileSessionRepository({ dataDir: tempDir() })
    const store = fakeStore()
    const logger = silentLogger()
    const sync = createDurableSessionSync({ repository: repo, store, logger })
    sync.start()
    const session = repo.create('org-a', CONFIG, resolved(ORG_A))
    repo.setOrganization(session.id, resolved(ORG_B)) // should never happen; the store must refuse it
    await sync.flush()
    expect(store.rows.get(session.id)?.organizationId).toBe(ORG_A)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not applied'), { sessionId: session.id })
  })

  it('an unresolved session is stored without organization, then attributed once resolved', async () => {
    const repo = new FileSessionRepository({ dataDir: tempDir() })
    const store = fakeStore()
    const sync = createDurableSessionSync({ repository: repo, store, logger: silentLogger() })
    sync.start()
    const session = repo.create('org-a', CONFIG, { status: 'unavailable' })
    await sync.flush()
    expect(store.rows.get(session.id)?.organizationId).toBeNull()
    repo.setOrganization(session.id, resolved(ORG_A))
    await sync.flush()
    expect(store.rows.get(session.id)?.organizationId).toBe(ORG_A)
    expect(organizationIdOf({ organization: { status: 'not_found' } } as StoredSession)).toBeNull()
  })

  it('stop() detaches the listener: later changes are no longer mirrored', async () => {
    const repo = new FileSessionRepository({ dataDir: tempDir() })
    const store = fakeStore()
    const sync = createDurableSessionSync({ repository: repo, store, logger: silentLogger() })
    sync.start()
    sync.stop()
    repo.create('org-a', CONFIG, resolved(ORG_A))
    await sync.flush()
    expect(store.saves).toHaveLength(0)
  })
})
