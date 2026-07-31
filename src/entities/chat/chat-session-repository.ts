import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import type { ChatMessage, ChatQualificationResult, ChatSession } from './types'

const STORAGE_KEY = 'lead-ai:chat-sessions:v1'

export interface CreateChatSessionInput {
  id: string
  orgSlug: string
  assistantName: string
  welcomeMessage: string
}

export interface ChatSessionRepository {
  list(): Promise<ChatSession[]>
  get(id: string): Promise<ChatSession | undefined>
  create(input: CreateChatSessionInput): Promise<ChatSession>
  appendMessage(id: string, message: ChatMessage): Promise<ChatSession | undefined>
  setQualification(id: string, qualification: ChatQualificationResult): Promise<ChatSession | undefined>
  linkLead(id: string, leadId: string): Promise<ChatSession | undefined>
}

function readSessions(): ChatSession[] {
  return readJSON<ChatSession[]>(STORAGE_KEY, [])
}

function writeSessions(sessions: ChatSession[]): void {
  writeJSON(STORAGE_KEY, sessions)
}

function updateSession(id: string, patch: (session: ChatSession) => ChatSession): ChatSession | undefined {
  const sessions = readSessions()
  const index = sessions.findIndex((session) => session.id === id)
  if (index === -1) return undefined

  const updated = patch(sessions[index])
  sessions[index] = updated
  writeSessions(sessions)
  return updated
}

export const localStorageChatSessionRepository: ChatSessionRepository = {
  async list() {
    return readSessions()
  },

  async get(id) {
    return readSessions().find((session) => session.id === id)
  },

  async create(input) {
    const now = new Date().toISOString()
    const session: ChatSession = {
      id: input.id,
      orgSlug: input.orgSlug,
      assistantName: input.assistantName,
      createdAt: now,
      updatedAt: now,
      messages: [{ id: crypto.randomUUID(), role: 'assistant', content: input.welcomeMessage, createdAt: now }],
    }
    writeSessions([session, ...readSessions()])
    return session
  },

  async appendMessage(id, message) {
    return updateSession(id, (session) => ({
      ...session,
      messages: [...session.messages, message],
      updatedAt: new Date().toISOString(),
    }))
  },

  async setQualification(id, qualification) {
    return updateSession(id, (session) => ({ ...session, qualification, updatedAt: new Date().toISOString() }))
  },

  async linkLead(id, leadId) {
    return updateSession(id, (session) => ({ ...session, leadId, updatedAt: new Date().toISOString() }))
  },
}
