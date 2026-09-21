import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { canCompleteOrganizationOnboarding, useOrganization } from '@/entities/organization'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileNav } from './MobileNav'
import { OrganizationPendingSetup } from './OrganizationPendingSetup'

export function AppShell() {
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false)
  const { organization, role } = useOrganization()

  // A member/viewer of an organization that hasn't finished /onboarding
  // never gets redirected there (see OnboardingGate.tsx) — they land here
  // instead, on whatever route they requested. Swap the routed page for a
  // read-only notice rather than letting them into an empty/half-seeded
  // dashboard (no chat config, no starter form yet) with no way to fix it.
  // Sidebar/Topbar/MobileNav below are unaffected — logout and the
  // organization switcher stay available exactly as they already are.
  const isPendingSetup = Boolean(organization) && !organization?.onboardingCompletedAt && !canCompleteOrganizationOnboarding(role)

  return (
    <div className="min-h-screen bg-vertice-bg text-slate-100">
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenMobileNav={() => setIsMobileNavOpen(true)} />
          <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <div className="mx-auto w-full max-w-6xl">
              {isPendingSetup ? <OrganizationPendingSetup /> : <Outlet />}
            </div>
          </main>
        </div>
      </div>
      <MobileNav isOpen={isMobileNavOpen} onClose={() => setIsMobileNavOpen(false)} />
    </div>
  )
}
