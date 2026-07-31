import { isSupabaseConfigured } from './supabase-client'

export type DataBackend = 'local' | 'supabase'

function resolveDataBackend(): DataBackend {
  const requested = import.meta.env.VITE_DATA_BACKEND

  if (requested === 'supabase') {
    if (isSupabaseConfigured) return 'supabase'
    console.warn(
      'VITE_DATA_BACKEND=supabase but VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY are not set — falling back to local storage. See .env.example.',
    )
    return 'local'
  }

  return 'local'
}

/**
 * Which repository implementation leads/forms/chat-config use. Chat
 * sessions are unaffected — they always go through the backend's
 * server/data/sessions.json regardless of this setting.
 */
export const dataBackend: DataBackend = resolveDataBackend()
