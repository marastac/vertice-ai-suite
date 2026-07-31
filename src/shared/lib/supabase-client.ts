import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

/**
 * Singleton Supabase client. Only constructed when both env vars are
 * present — callers must check `isSupabaseConfigured` (or rely on
 * `dataBackend`, see data-backend.ts, staying "local" when unset) before
 * touching `supabase`, since accessing it while unconfigured throws.
 */
export const supabase = isSupabaseConfigured ? createClient(supabaseUrl, supabaseAnonKey) : (null as never)
