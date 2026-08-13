import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { LOCAL_ORGANIZATION_ID } from './types'
import type { BusinessType, Organization, OrganizationInvite, OrganizationMembership, OrganizationRole } from './types'

export interface CreateInviteInput {
  organizationId: string
  email: string
  role: OrganizationRole
  invitedBy: string
}

export interface OrganizationRepository {
  listMyMemberships(userId: string): Promise<OrganizationMembership[]>
  createOrganization(name: string, createdBy: string): Promise<Organization>
  addSelfAsOwner(organizationId: string, userId: string): Promise<void>
  createInvite(input: CreateInviteInput): Promise<OrganizationInvite>
  listInvites(organizationId: string): Promise<OrganizationInvite[]>
  revokeInvite(inviteId: string): Promise<void>
  /** Phase 9: records the chosen business type and marks onboarding done — see app/layout/OnboardingGate.tsx. */
  completeOnboarding(organizationId: string, businessType: BusinessType): Promise<Organization>
}

// slug is deliberately 'vertice-agency', not 'local' — this keeps the
// pre-Phase-8 public chat URL (/c/vertice-agency, documented in README.md)
// working unchanged when running on the local backend.
const LOCAL_ORGANIZATION: Organization = { id: LOCAL_ORGANIZATION_ID, name: 'Organización local', slug: 'vertice-agency' }

const ONBOARDING_STORAGE_KEY = 'lead-ai:organization-onboarding:v1'

interface StoredOnboardingState {
  businessType: BusinessType
  onboardingCompletedAt: string
}

function readLocalOrganization(): Organization {
  const stored = readJSON<StoredOnboardingState | null>(ONBOARDING_STORAGE_KEY, null)
  if (!stored) return LOCAL_ORGANIZATION
  return { ...LOCAL_ORGANIZATION, businessType: stored.businessType, onboardingCompletedAt: stored.onboardingCompletedAt }
}

/**
 * Used when VITE_DATA_BACKEND=local. There is only ever one browser profile
 * in that mode, so real multi-tenancy doesn't apply — this always reports a
 * single stable pseudo-organization (owner role) and treats every
 * org-management action as a no-op except onboarding completion, which it
 * persists to localStorage (same "read, default if empty" pattern as every
 * other local repository) so /onboarding behaves consistently on both backends.
 */
export const localOrganizationRepository: OrganizationRepository = {
  async listMyMemberships() {
    return [{ organization: readLocalOrganization(), role: 'owner' }]
  },
  async createOrganization() {
    return readLocalOrganization()
  },
  async addSelfAsOwner() {
    // no-op — the local pseudo-organization always exists with a single owner
  },
  async createInvite() {
    throw new Error('Las invitaciones no están disponibles en modo local (VITE_DATA_BACKEND=local).')
  },
  async listInvites() {
    return []
  },
  async revokeInvite() {
    // no-op — nothing to revoke in local mode
  },
  async completeOnboarding(_organizationId, businessType) {
    const state: StoredOnboardingState = { businessType, onboardingCompletedAt: new Date().toISOString() }
    writeJSON(ONBOARDING_STORAGE_KEY, state)
    return readLocalOrganization()
  },
}
