import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ChatConfigurationInput, ChatQualificationResult } from '../schemas/chat.js'
import type { ChatTurn } from '../services/ai-provider.js'
import type { OrganizationResolution } from '../services/organization-lookup.js'
import { logger } from '../lib/logger.js'

/**
 * Where `StoredSession.config` came from, and therefore whether it's safe
 * to build an Anthropic system prompt from — see
 * chat-service.ts::ensureConfigTrusted() for the full decision logic.
 *
 *   - `server`: loaded by the backend itself from `chat_configuration` via
 *     `supabaseAdmin` (see repositories/chat-config-repository.ts), for an
 *     organization whose resolution is `resolved`. The only source ever
 *     used to build a real, production Anthropic prompt.
 *   - `local`: accepted from the client's request body ONLY because this
 *     backend has no Supabase configured at all (`organization.status ===
 *     'not_configured'`) — there is no server-side chat_configuration to
 *     load in that deployment, so the client's own config genuinely is
 *     the only config that exists (mirrors the pre-hardening behavior,
 *     scoped down to exactly the one case where trusting it is safe).
 */
export type ChatConfigSource = 'server' | 'local'

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
  /**
   * See ChatConfigSource's own doc comment for what each value means.
   * CRITICAL: `organization.status === 'resolved'` does NOT by itself mean
   * `config` is trustworthy — a session created before this hardening
   * existed, or created while its organization was still `'unavailable'`,
   * can hold `undefined` here with a `config` that was only ever a
   * client-supplied placeholder, never validated against
   * `chat_configuration`. `undefined` must NEVER be treated as
   * automatically trustworthy by any caller — see
   * chat-service.ts::ensureConfigTrusted(), which is the ONLY place that's
   * allowed to settle this field to a real value, always by either loading
   * the real `chat_configuration` row (→ `'server'`) or confirming this
   * backend has no Supabase at all (→ `'local'`). Never migrated/backfilled
   * for old on-disk sessions — they're upgraded lazily, on their next
   * message, exactly like `organization` above.
   */
  configSource?: ChatConfigSource
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
  /**
   * `configSource` is optional and typically only ever passed as `'server'`
   * or `'local'` at creation time when createSession() already knows which
   * one applies (a `resolved`/`not_configured` organization) — omitted
   * (left `undefined`) for an `'unavailable'` organization at creation
   * time, whose config is only a provisional placeholder until
   * ensureConfigTrusted() settles it on a later message.
   */
  create(
    orgSlug: string,
    config: ChatConfigurationInput,
    organization: OrganizationResolution,
    configSource?: ChatConfigSource,
  ): StoredSession
  get(id: string): StoredSession | undefined
  appendTurn(id: string, turn: ChatTurn): void
  setQualification(id: string, result: ChatQualificationResult): void
  /** Persists a freshly re-attempted organization resolution — see chat-service.ts::ensureOrganizationResolved(). */
  setOrganization(id: string, organization: OrganizationResolution): void
  /**
   * Persists a freshly-trusted config AND its source TOGETHER, in one
   * logical write (one `persist()` call — see FileSessionRepository below)
   * — see chat-service.ts::ensureConfigTrusted(). Deliberately not two
   * separate setters (a hypothetical setConfigValue()/setConfigSource()):
   * this session's `config` and `configSource` must never be observed
   * on disk in a state where one was updated and the other wasn't.
   */
  setConfig(id: string, config: ChatConfigurationInput, configSource: ChatConfigSource): void
}

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data')
const SESSIONS_FILE_NAME = 'sessions.json'

/**
 * Reads sessions.json. A file that exists but can't be parsed (e.g. truncated
 * by a crash in the middle of a write made before writes became atomic) is
 * NEVER overwritten: it's renamed aside to `sessions.corrupt-<timestamp>.json`
 * first, so its conversations can still be recovered by hand. Before this,
 * the next write silently replaced it with an empty store.
 */
function readSessionsFromDisk(dataFile: string): Map<string, StoredSession> {
  if (!existsSync(dataFile)) return new Map()

  try {
    const raw = readFileSync(dataFile, 'utf8')
    const entries = JSON.parse(raw) as [string, StoredSession][]
    return new Map(entries)
  } catch (error) {
    const preserved = path.join(path.dirname(dataFile), `sessions.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    try {
      renameSync(dataFile, preserved)
    } catch {
      // If even the rename fails, keep going: the atomic writes below never
      // truncate the original in place either.
    }
    logger.warn('Could not read sessions.json — preserved it aside and started with an empty session store', {
      message: error instanceof Error ? error.message : String(error),
      preservedAs: path.basename(preserved),
    })
    return new Map()
  }
}

export interface FileSessionRepositoryOptions {
  /** Directory holding sessions.json. Defaults to <cwd>/data. Injectable for tests. */
  dataDir?: string
}

/** Called after every change to a session (see setChangeListener()). Never allowed to break the chat. */
export type SessionChangeListener = (session: StoredSession) => void

export class FileSessionRepository implements SessionRepository {
  private readonly dataDir: string
  private readonly dataFile: string
  private readonly sessions: Map<string, StoredSession>
  private changeListener: SessionChangeListener | null = null

  constructor(options: FileSessionRepositoryOptions = {}) {
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR
    this.dataFile = path.join(this.dataDir, SESSIONS_FILE_NAME)
    this.sessions = readSessionsFromDisk(this.dataFile)
  }

  /**
   * Opt-in hook for a durable copy elsewhere (services/durable-session-sync.ts,
   * CHAT_SESSION_STORE=postgres). Not set by default — then nothing changes.
   */
  setChangeListener(listener: SessionChangeListener | null): void {
    this.changeListener = listener
  }

  /**
   * Adds sessions recovered from a durable copy (e.g. after a redeploy that
   * wiped sessions.json). A session already present locally is only replaced
   * if the recovered copy is strictly newer. Returns how many were applied.
   * Does NOT notify the change listener (they came from that store).
   */
  restore(recovered: StoredSession[]): number {
    let applied = 0
    for (const session of recovered) {
      const current = this.sessions.get(session.id)
      if (current && current.updatedAt >= session.updatedAt) continue
      this.sessions.set(session.id, session)
      applied += 1
    }
    if (applied > 0) this.writeFile()
    return applied
  }

  /** All sessions currently held (read-only use: diagnostics and tests). */
  list(): StoredSession[] {
    return [...this.sessions.values()]
  }

  private writeFile(): void {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
    // Atomic: write a sibling temp file, then rename it over sessions.json. A
    // crash mid-write leaves the previous complete file in place instead of a
    // truncated one. Synchronous on purpose: single process, one write per turn.
    const tempFile = `${this.dataFile}.${process.pid}.tmp`
    writeFileSync(tempFile, JSON.stringify([...this.sessions.entries()]))
    renameSync(tempFile, this.dataFile)
  }

  private persist(session?: StoredSession): void {
    this.writeFile()
    if (session && this.changeListener) {
      try {
        this.changeListener(session)
      } catch (error) {
        logger.warn('Session change listener failed — the conversation is unaffected', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  create(
    orgSlug: string,
    config: ChatConfigurationInput,
    organization: OrganizationResolution,
    configSource?: ChatConfigSource,
  ): StoredSession {
    const now = new Date().toISOString()
    const session: StoredSession = {
      id: randomUUID(),
      orgSlug,
      organization,
      config,
      configSource,
      createdAt: now,
      updatedAt: now,
      history: [],
    }
    this.sessions.set(session.id, session)
    this.persist(session)
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
    this.persist(session)
  }

  setQualification(id: string, result: ChatQualificationResult): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.qualification = result
    session.updatedAt = new Date().toISOString()
    this.persist(session)
  }

  setOrganization(id: string, organization: OrganizationResolution): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.organization = organization
    session.updatedAt = new Date().toISOString()
    this.persist(session)
  }

  setConfig(id: string, config: ChatConfigurationInput, configSource: ChatConfigSource): void {
    const session = this.sessions.get(id)
    if (!session) return
    // Both fields mutated before the single persist() below — see this
    // method's own doc comment on the SessionRepository interface for why
    // this must never be two separate writes.
    session.config = config
    session.configSource = configSource
    session.updatedAt = new Date().toISOString()
    this.persist(session)
  }
}

export const sessionRepository = new FileSessionRepository()
