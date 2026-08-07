import { supabase } from '@/shared/lib/supabase-client'
import type { CreateInviteInput, OrganizationRepository } from './organization-repository'
import type { Organization, OrganizationInvite, OrganizationRole } from './types'

interface MembershipRow {
  role: OrganizationRole
  organizations: { id: string; name: string; slug: string } | { id: string; name: string; slug: string }[]
}

interface InviteRow {
  id: string
  organization_id: string
  email: string
  role: OrganizationRole
  status: OrganizationInvite['status']
  created_at: string
  expires_at: string
}

function normalizeOrganization(value: MembershipRow['organizations']): Organization {
  // supabase-js returns the joined row as an object for a many-to-one
  // relationship, but its generated types are conservative and allow an
  // array shape too — normalize defensively rather than assuming one.
  const row = Array.isArray(value) ? value[0] : value
  return { id: row.id, name: row.name, slug: row.slug }
}

function inviteFromRow(row: InviteRow): OrganizationInvite {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role,
    status: row.status,
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
      .select('role, organizations(id, name, slug)')
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
}
