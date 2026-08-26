export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer'

/**
 * Phase 9: chosen once, during /onboarding, for a brand-new organization.
 * Drives which chat-assistant copy and starter form get created for it —
 * see entities/chat/business-type-templates.ts and entities/form/starter-templates.ts.
 */
export type BusinessType = 'content_creator' | 'course_creator' | 'online_business'

export interface Organization {
  id: string
  name: string
  slug: string
  businessType?: BusinessType
  /** Undefined/null means this organization hasn't been through /onboarding yet — see app/layout/OnboardingGate.tsx. */
  onboardingCompletedAt?: string
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
  token: string
  createdAt: string
  expiresAt: string
}

/** Result of get_invite_by_token() — what the public /accept-invite page previews before the visitor is a member of anything. */
export interface InvitePreview {
  organizationName: string
  organizationSlug: string
  role: OrganizationRole
  status: OrganizationInvite['status']
  expiresAt: string
  isUsable: boolean
}

/** Result of accept_invite() — enough to redirect the caller into their newly-joined organization. */
export interface AcceptInviteResult {
  organizationId: string
  organizationSlug: string
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
