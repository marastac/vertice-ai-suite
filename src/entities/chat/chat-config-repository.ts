import { LOCAL_ORGANIZATION_ID } from '@/entities/organization'
import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { createDefaultChatConfiguration } from './defaults'
import type { ChatConfiguration } from './types'

const STORAGE_KEY = 'lead-ai:chat-config:v1'

// Matches organization-repository.ts's localOrganizationRepository — the
// local pseudo-organization's public slug stays 'vertice-agency' so the
// pre-Phase-8 documented dev URL (/c/vertice-agency) keeps working.
const LOCAL_ORGANIZATION_SLUG = 'vertice-agency'

export interface ChatConfigRepository {
  get(organizationId: string): Promise<ChatConfiguration>
  save(organizationId: string, config: ChatConfiguration): Promise<ChatConfiguration>
  reset(organizationId: string): Promise<ChatConfiguration>
  /**
   * Org-agnostic lookup by public org slug, for the public (no-login)
   * /c/:orgSlug page — a chat visitor was never a member of any
   * organization. Returns the resolved organizationId alongside the config
   * since the caller (PublicChatPage) needs it to create the chat session
   * and, later, any lead the conversation qualifies.
   */
  getBySlug(slug: string): Promise<{ config: ChatConfiguration; organizationId: string } | undefined>
}

function readConfig(): ChatConfiguration {
  const stored = readJSON<ChatConfiguration | null>(STORAGE_KEY, null)
  if (stored) return stored
  // Safe defaults only apply the first time — once something is stored, this
  // branch never runs again, so a saved configuration is never overwritten.
  const initial = createDefaultChatConfiguration(LOCAL_ORGANIZATION_ID)
  writeJSON(STORAGE_KEY, initial)
  return initial
}

export const localStorageChatConfigRepository: ChatConfigRepository = {
  async get() {
    return readConfig()
  },

  async save(organizationId, config) {
    const updated: ChatConfiguration = { ...config, organizationId, updatedAt: new Date().toISOString() }
    writeJSON(STORAGE_KEY, updated)
    return updated
  },

  async reset(organizationId) {
    const reset = createDefaultChatConfiguration(organizationId)
    writeJSON(STORAGE_KEY, reset)
    return reset
  },

  async getBySlug(slug) {
    if (slug !== LOCAL_ORGANIZATION_SLUG) return undefined
    return { config: readConfig(), organizationId: LOCAL_ORGANIZATION_ID }
  },
}
