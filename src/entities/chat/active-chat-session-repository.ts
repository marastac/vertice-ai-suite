import { dataBackend } from '@/shared/lib/data-backend'
import { localStorageChatSessionRepository } from './chat-session-repository'
import { supabaseChatSessionRepository } from './chat-session-supabase-repository'
import type { ChatSessionRepository } from './chat-session-repository'

/**
 * Which ChatSessionRepository implementation is live, selected once at
 * module load by VITE_DATA_BACKEND. Every consumer (hooks.ts,
 * PublicChatPage.tsx, qualification-service.ts) imports this instead of a
 * concrete implementation directly.
 */
export const activeChatSessionRepository: ChatSessionRepository =
  dataBackend === 'supabase' ? supabaseChatSessionRepository : localStorageChatSessionRepository
