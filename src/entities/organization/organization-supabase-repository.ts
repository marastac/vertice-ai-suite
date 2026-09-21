import { supabase } from '@/shared/lib/supabase-client'
import type { CreateInviteInput, OrganizationRepository } from './organization-repository'
import type { AcceptInviteResult, BusinessType, InvitePreview, Organization, OrganizationInvite, OrganizationRole } from './types'

interface OrganizationRow {
  id: string
  name: string
  slug: string
  business_type: BusinessType | null
  onboarding_completed_at: string | null
  support_email: string | null
  brand_color: string | null
}

const ORGANIZATION_COLUMNS = 'id, name, slug, business_type, onboarding_completed_at, support_email, brand_color'

interface MembershipRow {
  role: OrganizationRole
  organizations: OrganizationRow | OrganizationRow[]
}

interface InviteRow {
  id: string
  organization_id: string
  email: string
  role: OrganizationRole
  status: OrganizationInvite['status']
  token: string
  created_at: string
  expires_at: string
}

// Shape returned by get_invite_by_token() — see supabase/schema.sql.
interface InvitePreviewRow {
  organization_name: string
  organization_slug: string
  role: OrganizationRole
  status: OrganizationInvite['status']
  expires_at: string
  is_usable: boolean
}

// Shape returned by accept_invite() — see supabase/schema.sql.
interface AcceptInviteRow {
  organization_id: string
  organization_slug: string
}

function normalizeOrganization(value: MembershipRow['organizations']): Organization {
  // supabase-js returns the joined row as an object for a many-to-one
  // relationship, but its generated types are conservative and allow an
  // array shape too — normalize defensively rather than assuming one.
  const row = Array.isArray(value) ? value[0] : value
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    businessType: row.business_type ?? undefined,
    onboardingCompletedAt: row.onboarding_completed_at ?? undefined,
    supportEmail: row.support_email ?? undefined,
    brandColor: row.brand_color ?? undefined,
  }
}

function inviteFromRow(row: InviteRow): OrganizationInvite {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role,
    status: row.status,
    token: row.token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

// Strips combining diacritical marks (Unicode code points 0x0300-0x036F)
// left over after normalize('NFD') decomposes an accented letter into a
// base letter plus a combining mark, e.g. "á" -> "a" + U+0301. Filtered by
// numeric code point rather than a regex containing the marks themselves,
// so this file stays plain ASCII.
function stripCombiningMarks(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code < 0x0300 || code > 0x036f
    })
    .join('')
}

function slugify(input: string): string {
  const base = stripCombiningMarks(input.toLowerCase().normalize('NFD'))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
  return base || 'org'
}

export const supabaseOrganizationRepository: OrganizationRepository = {
  async listMyMemberships(userId) {
    const { data, error } = await supabase
      .from('organization_members')
      .select(`role, organizations(${ORGANIZATION_COLUMNS})`)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return (data as MembershipRow[]).map((row) => ({
      role: row.role,
      organization: normalizeOrganization(row.organizations),
    }))
  },

  async createOrganization(name, createdBy) {
    const baseSlug = slugify(name)
    // Retries with a random suffix on a slug conflict (organizations.slug is
    // unique) — collisions are plausible since the slug is derived from a
    // user-provided display name, not chosen deliberately.
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`
      const { data, error } = await supabase
        .from('organizations')
        .insert({ name, slug, created_by: createdBy })
        .select('id, name, slug')
        .single()
      if (!error) return data as Organization
      if (error.code !== '23505') throw error
    }
    throw new Error('No se pudo crear la organización tras varios intentos (conflicto de slug).')
  },

  async addSelfAsOwner(organizationId, userId) {
    const { error } = await supabase
      .from('organization_members')
      .insert({ organization_id: organizationId, user_id: userId, role: 'owner' })
    if (error) throw error
  },

  async createInvite(input: CreateInviteInput) {
    const { data, error } = await supabase
      .from('organization_invites')
      .insert({
        organization_id: input.organizationId,
        email: input.email,
        role: input.role,
        invited_by: input.invitedBy,
      })
      .select('*')
      .single()
    if (error) throw error
    return inviteFromRow(data)
  },

  async listInvites(organizationId) {
    const { data, error } = await supabase
      .from('organization_invites')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data.map(inviteFromRow)
  },

  async revokeInvite(inviteId) {
    const { error } = await supabase.from('organization_invites').update({ status: 'revoked' }).eq('id', inviteId)
    if (error) throw error
  },

  async getInviteByToken(token): Promise<InvitePreview | null> {
    const { data, error } = await supabase.rpc('get_invite_by_token', { p_token: token }).maybeSingle()
    if (error) throw error
    if (!data) return null
    const row = data as InvitePreviewRow
    return {
      organizationName: row.organization_name,
      organizationSlug: row.organization_slug,
      role: row.role,
      status: row.status,
      expiresAt: row.expires_at,
      isUsable: row.is_usable,
    }
  },

  async acceptInvite(token): Promise<AcceptInviteResult> {
    const { data, error } = await supabase.rpc('accept_invite', { p_token: token }).single()
    if (error) throw error
    const row = data as AcceptInviteRow
    return { organizationId: row.organization_id, organizationSlug: row.organization_slug }
  },

  async completeOnboarding(organizationId, businessType) {
    // Selects the full column set (not just business_type/onboarding_completed_at)
    // so normalizeOrganization() never returns a row missing support_email/
    // brand_color — OrganizationProvider replaces the whole cached
    // Organization object with whatever this resolves to (see
    // OrganizationProvider.tsx's completeOnboarding), so a narrower select
    // here would wipe out any settings a caller had already saved.
    const { data, error } = await supabase
      .from('organizations')
      .update({ business_type: businessType, onboarding_completed_at: new Date().toISOString() })
      .eq('id', organizationId)
      .select(ORGANIZATION_COLUMNS)
      .single()
    if (error) throw error
    return normalizeOrganization(data as OrganizationRow)
  },

  async updateSettings(organizationId, input) {
    // Explicit whitelist, never a spread of caller input — id/slug/
    // created_by/created_at/business_type/onboarding_completed_at can never
    // reach this UPDATE no matter what SettingsPage.tsx passes in, since
    // UpdateOrganizationSettingsInput's TypeScript shape doesn't carry them
    // either. organizations_update_members' RLS (is_org_admin(id), see
    // supabase/schema.sql) is what actually rejects this for member/viewer —
    // this whitelist is defense-in-depth, not the real boundary.
    const { data, error } = await supabase
      .from('organizations')
      .update({
        name: input.name,
        support_email: input.supportEmail ?? null,
        brand_color: input.brandColor ?? null,
      })
      .eq('id', organizationId)
      .select(ORGANIZATION_COLUMNS)
      .single()
    if (error) throw error
    return normalizeOrganization(data as OrganizationRow)
  },
}
