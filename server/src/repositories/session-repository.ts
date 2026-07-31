import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ChatConfigurationInput, ChatQualificationResult } from '../schemas/chat.js'
import type { ChatTurn } from '../services/ai-provider.js'
import { logger } from '../lib/logger.js'

export interface StoredSession {
  id: string
  orgSlug: string
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
  create(orgSlug: string, config: ChatConfigurationInput): StoredSession
  get(id: string): StoredSession | undefined
  appendTurn(id: string, turn: ChatTurn): void
  setQualification(id: string, result: ChatQualificationResult): void
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

  create(orgSlug: string, config: ChatConfigurationInput): StoredSession {
    const now = new Date().toISOString()
    const session: StoredSession = {
      id: randomUUID(),
      orgSlug,
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
}

export const sessionRepository: SessionRepository = new FileSessionRepository()
