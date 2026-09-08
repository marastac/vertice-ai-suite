import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { mockTeamMembers } from './mock-data'
import type { AssignableTeamMemberRole, TeamMember, TeamMemberRole } from './types'

const STORAGE_KEY = 'lead-ai:team-members:v1'

export interface CreateTeamMemberInput {
  organizationId: string
  name: string
  email: string
  role: TeamMemberRole
}

export interface TeamMemberRepository {
  list(organizationId: string): Promise<TeamMember[]>
  /** Used to seed the owner's own row when a new organization is auto-provisioned — see entities/organization/OrganizationProvider.tsx. There is still no team-management UI to call this otherwise. */
  create(input: CreateTeamMemberInput): Promise<TeamMember>
  /**
   * Fase 10: changes a member's role. organization_members (not this table)
   * is the source of truth — this calls the update_member_role() RPC, which
   * mutates organization_members; team_members is kept in sync by a database
   * trigger, never written directly from the client. See supabase/schema.sql.
   * Throws AUTH_REQUIRED/NOT_ADMIN/INVALID_ROLE/MEMBER_NOT_FOUND/
   * CANNOT_MODIFY_OWNER/CANNOT_MODIFY_SELF — see entities/organization/member-errors.ts.
   */
  updateRole(organizationId: string, teamMemberId: string, newRole: AssignableTeamMemberRole): Promise<void>
  /**
   * Fase 10: removes a member from this organization only (their Supabase
   * Auth account and any membership in other organizations are untouched).
   * Calls remove_organization_member(), which deletes the organization_members
   * row; team_members is kept in sync by the same trigger as updateRole().
   * Throws AUTH_REQUIRED/NOT_ADMIN/MEMBER_NOT_FOUND/CANNOT_REMOVE_OWNER/
   * CANNOT_REMOVE_SELF — see entities/organization/member-errors.ts.
   */
  removeMember(organizationId: string, teamMemberId: string): Promise<void>
}

function readMembers(): TeamMember[] {
  const stored = readJSON<TeamMember[] | null>(STORAGE_KEY, null)
  if (stored) return stored
  writeJSON(STORAGE_KEY, mockTeamMembers)
  return [...mockTeamMembers]
}

function writeMembers(members: TeamMember[]): void {
  writeJSON(STORAGE_KEY, members)
}

export const localTeamMemberRepository: TeamMemberRepository = {
  async list() {
    // The local pseudo-organization is the only one that exists in this
    // mode (see LOCAL_ORGANIZATION_ID) — no organization_id filtering
    // needed, every stored member already belongs to it.
    return readMembers()
  },

  async create(input) {
    const members = readMembers()
    const member: TeamMember = { id: crypto.randomUUID(), name: input.name, email: input.email, role: input.role }
    writeMembers([...members, member])
    return member
  },

  async updateRole() {
    // Local mode has no real auth-backed organization_members table to speak
    // of — every user is the sole 'owner' of the one pseudo-organization
    // (see organization-repository.ts's localOrganizationRepository), so
    // there is no second member to manage in the first place.
    throw new Error('La gestión de roles no está disponible en modo local (VITE_DATA_BACKEND=local).')
  },

  async removeMember() {
    throw new Error('La gestión de miembros no está disponible en modo local (VITE_DATA_BACKEND=local).')
  },
}
