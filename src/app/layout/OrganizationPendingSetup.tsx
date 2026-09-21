import { Clock } from 'lucide-react'
import { EmptyState } from '@/shared/ui/EmptyState'

/**
 * Rendered by AppShell.tsx in place of the normal routed page (`<Outlet />`)
 * for a member/viewer whose active organization hasn't completed
 * /onboarding yet — see OnboardingGate.tsx's doc comment for why this
 * state exists instead of redirecting them to /onboarding. Deliberately a
 * plain content block, not a full page: it renders inside AppShell's
 * <main>, so Sidebar/Topbar/MobileNav (organization switcher, "Cerrar
 * sesión") stay exactly as they already are — nothing new to build there.
 */
export function OrganizationPendingSetup() {
  return (
    <EmptyState
      icon={<Clock className="size-5" />}
      title="Esta organización todavía está siendo configurada."
      description="El propietario o un administrador debe completar la configuración inicial antes de que puedas acceder. Mientras tanto, puedes cerrar sesión o cambiar a otra organización desde el menú."
      className="min-h-[60vh]"
    />
  )
}
