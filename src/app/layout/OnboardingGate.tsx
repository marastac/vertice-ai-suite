import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { canCompleteOrganizationOnboarding, useOrganization } from '@/entities/organization'

/**
 * Wraps the AppShell route tree, nested inside ProtectedRoute (which
 * already guarantees `organization` is loaded and non-null by the time
 * this renders — see ProtectedRoute.tsx). Sends a brand-new organization
 * (onboardingCompletedAt still unset) to /onboarding before it can reach
 * any dashboard page — but only when the signed-in member can actually
 * complete it (owner/admin, same threshold organizations_update_members'
 * RLS enforces — see canCompleteOrganizationOnboarding). A member/viewer
 * of a not-yet-onboarded organization is deliberately NOT redirected here:
 * completeOnboarding() would just fail server-side for them (they can't
 * satisfy is_org_admin(id)), and OnboardingPage.tsx has no functional form
 * for them anyway. Instead they fall through to `children` (AppShell), and
 * AppShell.tsx itself renders a read-only "still being set up" state in
 * place of the normal routed page — this is what avoids a redirect loop:
 * nothing here ever sends a member/viewer to /onboarding only to have
 * nothing useful for them to do there.
 *
 * `/onboarding` itself is deliberately NOT wrapped in this gate — see
 * router.tsx — otherwise an owner/admin could never reach it to complete
 * the flow.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { organization, role } = useOrganization()

  if (organization && !organization.onboardingCompletedAt && canCompleteOrganizationOnboarding(role)) {
    return <Navigate to="/onboarding" replace />
  }

  return <>{children}</>
}
