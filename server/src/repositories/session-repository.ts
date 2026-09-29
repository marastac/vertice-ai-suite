import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

  setConfig(id: string, config: ChatConfigurationInput, configSource: ChatConfigSource): void {
    const session = this.sessions.get(id)
    if (!session) return
    // Both fields mutated before the single persist() below — see this
    // method's own doc comment on the SessionRepository interface for why
    // this must never be two separate writes.
    session.config = config
    session.configSource = configSource
    session.updatedAt = new Date().toISOString()
    this.persist()
  }
}

export const sessionRepository: SessionRepository = new FileSessionRepository()
