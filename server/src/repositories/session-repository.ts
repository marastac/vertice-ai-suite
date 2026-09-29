import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ChatConfigurationInput, ChatQualificationResult } from '../schemas/chat.js'
import type { ChatTurn } from '../services/ai-provider.js'
import type { OrganizationResolution } from '../services/organization-lookup.js'
import { logger } from '../lib/logger.js'

export interface StoredSession {
  id: string
  orgSlug: string
  /**
   * This session's organization attribution — see
   * services/organization-lookup.ts::OrganizationResolution for the four
   * possible states and exactly what each means for whether Anthropic may
   * be called and whether usage may be recorded. Set at creation time
   * (`createSession()` already rejects a brand-new `not_found` outright —
   * see its own doc comment — so this field can only ever start out as
   * `resolved`/`not_configured`/`unavailable`) and re-settled per-message
   * whenever it's still `'unavailable'` (never for `'resolved'`,
   * `'not_configured'`, or `'not_found'`, all three of which are treated
   * as final once reached) — see chat-service.ts::ensureOrganizationResolved().
   *
   * A session already on disk from before this field existed (or from
   * before it had this exact shape) simply reads back as `undefined` at
   * runtime — never a crash, since every read of this field is a safe
   * optional-chained check, and ensureOrganizationResolved() treats
   * `undefined` exactly like `'unavailable'`: worth a fresh resolution
   * attempt before spending any new tokens, never a reason to break the
   * conversation.
   */
  organization: OrganizationResolution
  config: ChatConfigurationInput
  createdAt: string
  updatedAt: string
  history: ChatTurn[]
  qualification?: ChatQualificationResult
}

/**
 * Repository abstraction over chat-session state. Backed by a JSON file on
 * disk so sessions survive a server restart — no external database yet.
 * Swap this for a real database later without touching the routes/services
 * that depend on it.
 */
export interface SessionRepository {
  create(orgSlug: string, config: ChatConfigurationInput, organization: OrganizationResolution): StoredSession
  get(id: string): StoredSession | undefined
  appendTurn(id: string, turn: ChatTurn): void
  setQualification(id: string, result: ChatQualificationResult): void
  /** Persists a freshly re-attempted organization resolution — see chat-service.ts::ensureOrganizationResolved(). */
  setOrganization(id: string, organization: OrganizationResolution): void
}

const DATA_DIR = path.resolve(process.cwd(), 'data')
const DATA_FILE = path.join(DATA_DIR, 'sessions.json')

function readSessionsFromDisk(): Map<string, StoredSession> {
  if (!existsSync(DATA_FILE)) return new Map()

  try {
    const raw = readFileSync(DATA_FILE, 'utf8')
    const entries = JSON.parse(raw) as [string, StoredSession][]
    return new Map(entries)
  } catch (error) {
    logger.warn('Could not read sessions.json, starting with an empty session store', {
      message: error instanceof Error ? error.message : String(error),
    })
    return new Map()
  }
}

class FileSessionRepository implements SessionRepository {
  private sessions = readSessionsFromDisk()

  private persist(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    // Writes are infrequent (once per chat turn) and this is a single-process
    // local backend, so a synchronous write is simpler and safer than
    // building a write queue for now.
    writeFileSync(DATA_FILE, JSON.stringify([...this.sessions.entries()]))
  }

  create(orgSlug: string, config: ChatConfigurationInput, organization: OrganizationResolution): StoredSession {
    const now = new Date().toISOString()
    const session: StoredSession = {
      id: randomUUID(),
      orgSlug,
      organization,
      config,
      createdAt: now,
      updatedAt: now,
      history: [],
    }
    this.sessions.set(session.id, session)
    this.persist()
    return session
  }

  get(id: string): StoredSession | undefined {
    return this.sessions.get(id)
  }

  appendTurn(id: string, turn: ChatTurn): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.history.push(turn)
    session.updatedAt = new Date().toISOString()
    this.persist()
  }

  setQualification(id: string, result: ChatQualificationResult): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.qualification = result
    session.updatedAt = new Date().toISOString()
    this.persist()
  }

  setOrganization(id: string, organization: OrganizationResolution): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.organization = organization
    session.updatedAt = new Date().toISOString()
    this.persist()
  }
}

export const sessionRepository: SessionRepository = new FileSessionRepository()
