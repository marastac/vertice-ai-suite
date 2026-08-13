import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useOrganization } from '@/entities/organization'

/**
 * Wraps the AppShell route tree, nested inside ProtectedRoute (which
 * already guarantees `organization` is loaded and non-null by the time
 * this renders — see ProtectedRoute.tsx). Sends a brand-new organization
 * (onboardingCompletedAt still unset) to /onboarding before it can reach
 * any dashboard page. `/onboarding` itself is deliberately NOT wrapped in
 * this gate — see router.tsx — otherwise nobody could ever reach it to
 * complete the flow.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { organization } = useOrganization()

  if (organization && !organization.onboardingCompletedAt) {
    return <Navigate to="/onboarding" replace />
  }

  return <>{children}</>
}
