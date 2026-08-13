import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import type { ChatMessage, ChatQualificationResult, ChatSession } from './types'

const STORAGE_KEY = 'lead-ai:chat-sessions:v1'

export interface CreateChatSessionInput {
  id: string
  organizationId: string
  orgSlug: string
  assistantName: string
  welcomeMessage: string
}

export interface ChatSessionRepository {
  list(organizationId: string): Promise<ChatSession[]>
  get(organizationId: string, id: string): Promise<ChatSession | undefined>
  create(input: CreateChatSessionInput): Promise<ChatSession>
  /**
   * appendMessage/setQualification/linkLead are keyed by `id` alone (no
   * organizationId) — on the Supabase backend, each is a SECURITY DEFINER
   * RPC that derives/validates organization ownership itself server-side
   * (see supabase/schema.sql's append_chat_message/set_chat_session_qualification/
   * link_chat_session_lead). None of their return values are used by any
   * caller today (PublicChatPage/qualification-service.ts always await and
   * discard them), so they return void rather than reconstructing a partial
   * ChatSession.
   */
  appendMessage(id: string, message: ChatMessage): Promise<void>
  setQualification(id: string, qualification: ChatQualificationResult): Promise<void>
  linkLead(id: string, leadId: string): Promise<void>
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
  async list(organizationId) {
    return readSessions().filter((session) => session.organizationId === organizationId)
  },

  async get(organizationId, id) {
    return readSessions().find((session) => session.id === id && session.organizationId === organizationId)
  },

  async create(input) {
    const now = new Date().toISOString()
    const session: ChatSession = {
      id: input.id,
      organizationId: input.organizationId,
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
    updateSession(id, (session) => ({
      ...session,
      messages: [...session.messages, message],
      updatedAt: new Date().toISOString(),
    }))
  },

  async setQualification(id, qualification) {
    updateSession(id, (session) => ({ ...session, qualification, updatedAt: new Date().toISOString() }))
  },

  async linkLead(id, leadId) {
    updateSession(id, (session) => ({ ...session, leadId, updatedAt: new Date().toISOString() }))
  },
}
