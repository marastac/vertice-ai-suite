import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/entities/auth'
import { useOrganization } from '@/entities/organization'

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, isLoading: isAuthLoading, isSupabaseConfigured } = useAuth()
  // Also wait on the organization to resolve — otherwise a just-registered
  // user would briefly render the dashboard with organization: null (every
  // org-scoped query hook disabled) while OrganizationProvider is still
  // auto-provisioning their first organization in the background.
  const { isLoading: isOrgLoading } = useOrganization()
  const location = useLocation()

  if (isAuthLoading || (user && isOrgLoading)) {
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
