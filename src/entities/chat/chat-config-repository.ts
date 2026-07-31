import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { createDefaultChatConfiguration } from './defaults'
import type { ChatConfiguration } from './types'

const STORAGE_KEY = 'lead-ai:chat-config:v1'

export interface ChatConfigRepository {
  get(): Promise<ChatConfiguration>
  save(config: ChatConfiguration): Promise<ChatConfiguration>
  reset(): Promise<ChatConfiguration>
}

function readConfig(): ChatConfiguration {
  const stored = readJSON<ChatConfiguration | null>(STORAGE_KEY, null)
  if (stored) return stored
  // Safe defaults only apply the first time — once something is stored, this
  // branch never runs again, so a saved configuration is never overwritten.
  const initial = createDefaultChatConfiguration()
  writeJSON(STORAGE_KEY, initial)
  return initial
}

export const localStorageChatConfigRepository: ChatConfigRepository = {
  async get() {
    return readConfig()
  },

  async save(config) {
    const updated: ChatConfiguration = { ...config, updatedAt: new Date().toISOString() }
    writeJSON(STORAGE_KEY, updated)
    return updated
  },

  async reset() {
    const reset = createDefaultChatConfiguration()
    writeJSON(STORAGE_KEY, reset)
    return reset
  },
}
