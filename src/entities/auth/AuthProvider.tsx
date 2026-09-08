import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from '@/shared/lib/supabase-client'
import { AuthContext } from './auth-context'
import type { AuthContextValue, AuthResult, SignUpResult } from './auth-context'
import { translateAuthError } from './auth-errors'

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(isSupabaseConfigured)
  // Tracks whose data is currently in the React Query cache. Every org-scoped
  // query key (leads, forms, invites, ...) is keyed by organizationId, not
  // userId — two accounts sharing an organization in the same browser tab
  // (e.g. testing an invite flow: sign out as owner, sign in as the invited
  // member) would otherwise see whatever the previous account's queries left
  // cached under that same key, even after the new account's role/permissions
  // have correctly loaded. Clearing on every actual user change closes that.
  const previousUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isSupabaseConfigured) return

    supabase.auth.getSession().then(({ data }) => {
      previousUserIdRef.current = data.session?.user.id ?? null
      setSession(data.session)
      setIsLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const nextUserId = nextSession?.user.id ?? null
      if (nextUserId !== previousUserIdRef.current) {
        queryClient.clear()
      }
      previousUserIdRef.current = nextUserId
      setSession(nextSession)
      setIsLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [queryClient])

  const signIn = async (email: string, password: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error ? translateAuthError(error.message) : null }
  }

  const signUp = async (email: string, password: string, fullName: string): Promise<SignUpResult> => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    })
    if (error) return { error: translateAuthError(error.message), needsEmailConfirmation: false }
    return { error: null, needsEmailConfirmation: !data.session }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  const sendPasswordReset = async (email: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    return { error: error ? translateAuthError(error.message) : null }
  }

  const updatePassword = async (password: string): Promise<AuthResult> => {
    const { error } = await supabase.auth.updateUser({ password })
    return { error: error ? translateAuthError(error.message) : null }
  }

  const value: AuthContextValue = {
    user: session?.user ?? null,
    session,
    isLoading,
    isSupabaseConfigured,
    signIn,
    signUp,
    signOut,
    sendPasswordReset,
    updatePassword,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
