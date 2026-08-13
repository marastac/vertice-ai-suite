import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '@/entities/auth'
import { activeTeamMemberRepository } from '@/entities/team-member'
import { dataBackend } from '@/shared/lib/data-backend'
import { activeOrganizationRepository } from './active-organization-repository'
import { completeOrganizationOnboarding } from './onboarding-service'
import { OrganizationContext } from './organization-context'
import type { OrganizationContextValue } from './organization-context'
import { LOCAL_ORGANIZATION_ID } from './types'
import type { BusinessType, Organization, OrganizationMembership, OrganizationRole } from './types'

// slug matches organization-repository.ts's localOrganizationRepository —
// see its comment for why this is 'vertice-agency', not 'local'.
const LOCAL_ORGANIZATION: Organization = { id: LOCAL_ORGANIZATION_ID, name: 'Organización local', slug: 'vertice-agency' }
const LOCAL_MEMBERSHIP: OrganizationMembership = { organization: LOCAL_ORGANIZATION, role: 'owner' }

function deriveOrganizationName(user: { email?: string | null; user_metadata?: Record<string, unknown> }): string {
  const fullName = typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : undefined
  const base = fullName?.trim() || user.email?.split('@')[0] || 'Mi organización'
  return `Organización de ${base}`
}

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [memberships, setMemberships] = useState<OrganizationMembership[]>([])
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      setMemberships([])
      setActiveOrganizationId(null)
      setError(null)
      return
    }

    if (dataBackend !== 'supabase') {
      setMemberships([LOCAL_MEMBERSHIP])
      setActiveOrganizationId(LOCAL_ORGANIZATION_ID)
      return
    }

    let cancelled = false

    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        let myMemberships = await activeOrganizationRepository.listMyMemberships(user!.id)

        if (myMemberships.length === 0) {
          // First login for this user: silently provision a personal
          // organization so they're never stuck on an empty dashboard —
          // confirmed with the product owner as the Phase 8 approach,
          // rather than adding an "organization name" field to the Phase 7
          // Register form. Also seeds one team_members row for the owner
          // themselves, so the "Persona asignada" dropdown on a brand-new
          // organization isn't empty on day one (there's no team-management
          // UI yet to add one otherwise).
          const org = await activeOrganizationRepository.createOrganization(deriveOrganizationName(user!), user!.id)
          await activeOrganizationRepository.addSelfAsOwner(org.id, user!.id)
          const ownerName = deriveOrganizationName(user!).replace(/^Organización de /, '')
          if (user!.email) {
            await activeTeamMemberRepository.create({
              organizationId: org.id,
              name: ownerName,
              email: user!.email,
              role: 'owner',
            })
          }
          myMemberships = await activeOrganizationRepository.listMyMemberships(user!.id)
        }

        if (cancelled) return
        setMemberships(myMemberships)
        setActiveOrganizationId((current) => current ?? myMemberships[0]?.organization.id ?? null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'No se pudo cargar la organización.')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [user])

  const switchOrganization = useCallback(
    (organizationId: string) => {
      if (memberships.some((membership) => membership.organization.id === organizationId)) {
        setActiveOrganizationId(organizationId)
      }
    },
    [memberships],
  )

  const active = memberships.find((membership) => membership.organization.id === activeOrganizationId)

  const completeOnboarding = useCallback(
    async (businessType: BusinessType) => {
      if (!active) throw new Error('No hay una organización activa.')
      const updated = await completeOrganizationOnboarding(active.organization.id, businessType)
      // Patch in place rather than re-fetching memberships — OnboardingGate
      // reads `organization.onboardingCompletedAt` on the very next render,
      // so this needs to be synchronous with the mutation resolving.
      setMemberships((current) =>
        current.map((membership) =>
          membership.organization.id === updated.id ? { ...membership, organization: updated } : membership,
        ),
      )
    },
    [active],
  )

  const value: OrganizationContextValue = useMemo(
    () => ({
      organization: active?.organization ?? null,
      role: (active?.role as OrganizationRole | undefined) ?? null,
      organizations: memberships,
      isLoading,
      error,
      switchOrganization,
      completeOnboarding,
    }),
    [active, memberships, isLoading, error, switchOrganization, completeOnboarding],
  )

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>
}
