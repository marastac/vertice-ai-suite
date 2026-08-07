import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { mockTeamMembers } from './mock-data'
import type { TeamMember, TeamMemberRole } from './types'

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
}
