import { createContext } from 'react'
import type { Session, User } from '@supabase/supabase-js'

export interface AuthResult {
  error: string | null
}

export interface SignUpResult extends AuthResult {
  /** True when Supabase requires email confirmation before a session exists (default project setting). */
  needsEmailConfirmation: boolean
}

export interface AuthContextValue {
  user: User | null
  session: Session | null
  /** True until the initial session lookup (and, when configured, the Supabase client itself) resolves. */
  isLoading: boolean
  /** Mirrors shared/lib/supabase-client's isSupabaseConfigured — auth pages use this to show a setup message instead of a broken form. */
  isSupabaseConfigured: boolean
  signIn: (email: string, password: string) => Promise<AuthResult>
  signUp: (email: string, password: string, fullName: string) => Promise<SignUpResult>
  signOut: () => Promise<void>
  sendPasswordReset: (email: string) => Promise<AuthResult>
  updatePassword: (password: string) => Promise<AuthResult>
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)
