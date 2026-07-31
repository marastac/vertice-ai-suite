import { dataBackend } from '@/shared/lib/data-backend'
import { localStorageChatConfigRepository } from './chat-config-repository'
import { supabaseChatConfigRepository } from './chat-config-supabase-repository'
import type { ChatConfigRepository } from './chat-config-repository'

/**
 * Which ChatConfigRepository implementation is live, selected once at
 * module load by VITE_DATA_BACKEND. Every consumer (hooks.ts) imports this
 * instead of a concrete implementation directly.
 */
export const activeChatConfigRepository: ChatConfigRepository =
  dataBackend === 'supabase' ? supabaseChatConfigRepository : localStorageChatConfigRepository
