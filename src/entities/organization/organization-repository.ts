import { LOCAL_ORGANIZATION_ID } from './types'
import type { Organization, OrganizationInvite, OrganizationMembership, OrganizationRole } from './types'

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
}

// slug is deliberately 'vertice-agency', not 'local' — this keeps the
// pre-Phase-8 public chat URL (/c/vertice-agency, documented in README.md)
// working unchanged when running on the local backend.
const LOCAL_ORGANIZATION: Organization = { id: LOCAL_ORGANIZATION_ID, name: 'Organización local', slug: 'vertice-agency' }

/**
 * Used when VITE_DATA_BACKEND=local. There is only ever one browser profile
 * in that mode, so real multi-tenancy doesn't apply — this always reports a
 * single stable pseudo-organization (owner role) and treats every
 * org-management action as a no-op, so the rest of the app never has to
 * special-case "there is no organization" when running locally.
 */
export const localOrganizationRepository: OrganizationRepository = {
  async listMyMemberships() {
    return [{ organization: LOCAL_ORGANIZATION, role: 'owner' }]
  },
  async createOrganization() {
    return LOCAL_ORGANIZATION
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
}
