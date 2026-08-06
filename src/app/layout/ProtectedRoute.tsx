import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/entities/auth'

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, isLoading, isSupabaseConfigured } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-vertice-bg">
        <Loader2 className="size-6 animate-spin text-slate-400" />
      </div>
    )
  }

  if (!isSupabaseConfigured || !user) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return <>{children}</>
}
