import { createContext } from 'react'
import type { BusinessType, Organization, OrganizationMembership, OrganizationRole } from './types'
import type { UpdateOrganizationSettingsInput } from './organization-repository'

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
  /**
   * /settings — saves name/supportEmail/brandColor for the active
   * organization and patches it into `organization`/`organizations` in
   * place, the same way completeOnboarding does above, so the sidebar/
   * header/team switcher reflect the new name immediately with no reload.
   * Throws (does not swallow) on failure — e.g. organizations_update_members'
   * RLS rejecting a non-owner/admin caller — so callers can show a real
   * error instead of a false success. Gate calls with
   * canEditOrganizationSettings; RLS is the real enforcement either way.
   */
  updateSettings: (input: UpdateOrganizationSettingsInput) => Promise<void>
}

export const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined)
