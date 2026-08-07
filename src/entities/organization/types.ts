export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface Organization {
  id: string
  name: string
  slug: string
}

export interface OrganizationMembership {
  organization: Organization
  role: OrganizationRole
}

export interface OrganizationInvite {
  id: string
  organizationId: string
  email: string
  role: OrganizationRole
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  createdAt: string
  expiresAt: string
}

/**
 * Stable pseudo-organization id used by every entity's local (localStorage)
 * repository when VITE_DATA_BACKEND=local. There is only ever one browser
 * profile in that mode, so real multi-tenancy doesn't apply — this exists
 * purely so Lead/QualificationForm/etc. can carry a real, non-optional
 * organizationId consistently across both backends instead of special-casing
 * "local mode has no organization" throughout the app.
 */
export const LOCAL_ORGANIZATION_ID = 'local'
