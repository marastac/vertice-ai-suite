import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { LOCAL_ORGANIZATION_ID } from './types'
import type {
  AcceptInviteResult,
  BusinessType,
  InvitePreview,
  Organization,
  OrganizationInvite,
  OrganizationMembership,
  OrganizationRole,
} from './types'

export interface CreateInviteInput {
  organizationId: string
  email: string
  role: OrganizationRole
  invitedBy: string
}

/**
 * Explicit whitelist for /settings — deliberately excludes id, slug,
 * organization_id-equivalent (this row's own id), created_by, created_at,
 * business_type, and onboarding_completed_at. A caller can never smuggle a
 * change to any of those through this shape, at the TypeScript level, no
 * matter what SettingsPage.tsx does.
 */
export interface UpdateOrganizationSettingsInput {
  name: string
  supportEmail?: string
  brandColor?: string
}

export interface OrganizationRepository {
  listMyMemberships(userId: string): Promise<OrganizationMembership[]>
  createOrganization(name: string, createdBy: string): Promise<Organization>
  addSelfAsOwner(organizationId: string, userId: string): Promise<void>
  createInvite(input: CreateInviteInput): Promise<OrganizationInvite>
  listInvites(organizationId: string): Promise<OrganizationInvite[]>
  revokeInvite(inviteId: string): Promise<void>
  /** Public preview of an invite by its token — no organization membership required. Returns null if the token doesn't exist. */
  getInviteByToken(token: string): Promise<InvitePreview | null>
  /** Accepts an invite, joining the caller into its organization. Throws on AUTH_REQUIRED/INVITE_NOT_FOUND/INVITE_NOT_USABLE/EMAIL_MISMATCH — see supabase/schema.sql's accept_invite(). */
  acceptInvite(token: string): Promise<AcceptInviteResult>
  /** Phase 9: records the chosen business type and marks onboarding done — see app/layout/OnboardingGate.tsx. */
  completeOnboarding(organizationId: string, businessType: BusinessType): Promise<Organization>
  /**
   * /settings — updates only name/supportEmail/brandColor for one
   * organization. The Supabase implementation relies on
   * organizations_update_members' RLS (is_org_admin(id)) to reject this for
   * anyone but owner/admin — see supabase/schema.sql and
   * supabase/migrations-organization-settings.sql. Callers should still
   * gate the UI with canEditOrganizationSettings so a member/viewer never
   * sees a call fail that they should never have been able to attempt.
   */
  updateSettings(organizationId: string, input: UpdateOrganizationSettingsInput): Promise<Organization>
}

// slug is deliberately 'vertice-agency', not 'local' — this keeps the
// pre-Phase-8 public chat URL (/c/vertice-agency, documented in README.md)
// working unchanged when running on the local backend.
const LOCAL_ORGANIZATION: Organization = { id: LOCAL_ORGANIZATION_ID, name: 'Organización local', slug: 'vertice-agency' }

const ONBOARDING_STORAGE_KEY = 'lead-ai:organization-onboarding:v1'
const SETTINGS_STORAGE_KEY = 'lead-ai:organization-settings:v1'

interface StoredOnboardingState {
  businessType: BusinessType
  onboardingCompletedAt: string
}

// Same shape as UpdateOrganizationSettingsInput — kept as its own local
// type rather than importing it, since this file only needs to round-trip
// it through localStorage, not enforce the repository contract.
interface StoredSettingsState {
  name: string
  supportEmail?: string
  brandColor?: string
}

function readLocalOrganization(): Organization {
  const onboarding = readJSON<StoredOnboardingState | null>(ONBOARDING_STORAGE_KEY, null)
  const settings = readJSON<StoredSettingsState | null>(SETTINGS_STORAGE_KEY, null)
  return {
    ...LOCAL_ORGANIZATION,
    ...(settings ? { name: settings.name, supportEmail: settings.supportEmail, brandColor: settings.brandColor } : {}),
    ...(onboarding ? { businessType: onboarding.businessType, onboardingCompletedAt: onboarding.onboardingCompletedAt } : {}),
  }
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
  async getInviteByToken() {
    throw new Error('Las invitaciones no están disponibles en modo local (VITE_DATA_BACKEND=local).')
  },
  async acceptInvite() {
    throw new Error('Las invitaciones no están disponibles en modo local (VITE_DATA_BACKEND=local).')
  },
  async completeOnboarding(_organizationId, businessType) {
    const state: StoredOnboardingState = { businessType, onboardingCompletedAt: new Date().toISOString() }
    writeJSON(ONBOARDING_STORAGE_KEY, state)
    return readLocalOrganization()
  },
  async updateSettings(_organizationId, input) {
    const state: StoredSettingsState = { name: input.name, supportEmail: input.supportEmail, brandColor: input.brandColor }
    writeJSON(SETTINGS_STORAGE_KEY, state)
    return readLocalOrganization()
  },
}
