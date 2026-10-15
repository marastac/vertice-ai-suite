import { logger as defaultLogger } from '../lib/logger.js'
import type { FileSessionRepository, StoredSession } from '../repositories/session-repository.js'

/**
 * Durable copy of the backend's chat sessions in Postgres
 * (supabase/migrations-backend-chat-sessions.sql). OPT-IN: only started when
 * CHAT_SESSION_STORE=postgres (see index.ts) — otherwise nothing here runs and
 * sessions live only in server/data/sessions.json, exactly as before.
 *
 * sessions.json stays the primary, synchronous store the chat reads from. This
 * module adds two things on top:
 *   - write-behind: after every change, the full session snapshot is saved to
 *     Postgres, serialized per session and versioned, so a slow or failed
 *     write never delays, reorders or breaks the conversation;
 *   - recovery: at startup, recent sessions missing from disk (e.g. a Railway
 *     redeploy without a volume wiped sessions.json) are restored from
 *     Postgres before the server starts listening.
 */

export interface SessionSnapshot {
  id: string
  organizationId: string | null
  orgSlug: string
  state: StoredSession
  version: number
}

export type StoreResult<T> = { ok: true; data: T } | { ok: false; message: string }

/** Persistence port — Supabase in production, an in-memory fake in tests. Must never throw. */
export interface SessionSnapshotStore {
  /** Saves a snapshot; `data` is false when the database kept a newer version (or refused an organization change). */
  save(snapshot: SessionSnapshot): Promise<StoreResult<boolean>>
  loadRecent(sinceIso: string, limit: number): Promise<StoreResult<SessionSnapshot[]>>
}

export interface DurableSessionSyncOptions {
  repository: Pick<FileSessionRepository, 'setChangeListener' | 'restore'>
  store: SessionSnapshotStore
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>
  /** Clock in ms — injectable for tests. */
  now?: () => number
  /** How far back recovery looks. Default 14 days. */
  recoveryWindowMs?: number
  recoveryLimit?: number
}

export interface DurableSessionSync {
  /** Restores recent sessions from Postgres into the file repository. Never throws. */
  hydrate(): Promise<{ restored: number; ok: boolean }>
  /** Starts mirroring every change. */
  start(): void
  /** Waits for every pending write (graceful shutdown). */
  flush(): Promise<void>
  stop(): void
}

const DAY_MS = 24 * 60 * 60 * 1000

export function organizationIdOf(session: StoredSession): string | null {
  return session.organization?.status === 'resolved' ? session.organization.organizationId : null
}

export function createDurableSessionSync(options: DurableSessionSyncOptions): DurableSessionSync {
  const log = options.logger ?? defaultLogger
  const now = options.now ?? Date.now
  const versions = new Map<string, number>()
  const chains = new Map<string, Promise<void>>()

  // Monotonic per session AND across restarts: never below the wall clock, so
  // a restart that couldn't hydrate still writes versions newer than anything
  // stored before it (the database ignores older ones).
  function nextVersion(id: string): number {
    const version = Math.max((versions.get(id) ?? 0) + 1, now())
    versions.set(id, version)
    return version
  }

  function enqueue(session: StoredSession): void {
    // Snapshot NOW (synchronously): later mutations of the same object must
    // not leak into this version's payload.
    const snapshot: SessionSnapshot = {
      id: session.id,
      organizationId: organizationIdOf(session),
      orgSlug: session.orgSlug,
      state: structuredClone(session),
      version: nextVersion(session.id),
    }
    const previous = chains.get(session.id) ?? Promise.resolve()
    const next = previous
      .then(() => options.store.save(snapshot))
      .then((result) => {
        if (!result.ok) {
          log.warn('Durable session copy failed — the conversation continues from sessions.json', {
            sessionId: snapshot.id,
            message: result.message,
          })
        } else if (!result.data) {
          log.warn('Durable session copy not applied (newer version stored or organization mismatch)', { sessionId: snapshot.id })
        }
      })
      .catch((error: unknown) => {
        log.warn('Durable session copy threw — the conversation continues from sessions.json', {
          sessionId: snapshot.id,
          message: error instanceof Error ? error.message : String(error),
        })
      })
    chains.set(session.id, next)
    void next.then(() => {
      if (chains.get(session.id) === next) chains.delete(session.id)
    })
  }

  return {
    async hydrate() {
      const since = new Date(now() - (options.recoveryWindowMs ?? 14 * DAY_MS)).toISOString()
      const result = await options.store.loadRecent(since, options.recoveryLimit ?? 5000).catch(
        (error: unknown): StoreResult<SessionSnapshot[]> => ({ ok: false, message: error instanceof Error ? error.message : String(error) }),
      )
      if (!result.ok) {
        log.warn('Could not recover sessions from Postgres — continuing with sessions.json only', { message: result.message })
        return { restored: 0, ok: false }
      }
      for (const snapshot of result.data) {
        versions.set(snapshot.id, Math.max(versions.get(snapshot.id) ?? 0, snapshot.version))
      }
      const restored = options.repository.restore(result.data.map((snapshot) => snapshot.state))
      log.info('Recovered chat sessions from Postgres', { found: result.data.length, restored })
      return { restored, ok: true }
    },
    start() {
      options.repository.setChangeListener(enqueue)
    },
    async flush() {
      await Promise.all([...chains.values()])
    },
    stop() {
      options.repository.setChangeListener(null)
    },
  }
}
