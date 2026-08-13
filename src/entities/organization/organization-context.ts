import { createContext } from 'react'
import type { BusinessType, Organization, OrganizationMembership, OrganizationRole } from './types'

export interface OrganizationContextValue {
  organization: Organization | null
  role: OrganizationRole | null
  /** Every organization the current user belongs to — today always length 0 or 1, kept as a list so a future org switcher has something to render. */
  organizations: OrganizationMembership[]
  isLoading: boolean
  error: string | null
  /** No-op if organizationId isn't one of `organizations` (e.g. not a member). Prepared for a future multi-org UI — today there's only ever one to switch to. */
  switchOrganization: (organizationId: string) => void
  /** Phase 9: completes /onboarding for the active organization — sets its business type, regenerates chat config, and creates a starter form. See entities/organization/onboarding-service.ts. */
  completeOnboarding: (businessType: BusinessType) => Promise<void>
}

export const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined)
