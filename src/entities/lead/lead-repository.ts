import { mockTeamMembers } from '@/entities/team-member'
import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { buildCreateActivityMessage, buildUpdateActivityMessages } from './lead-activity'
import { mockLeads } from './mock-data'
import type { LeadFormValues } from './schema'
import type { Lead, LeadActivityEntry } from './types'

const STORAGE_KEY = 'lead-ai:leads:v1'

export type CreateLeadInput = LeadFormValues & {
  organizationId: string
  formId?: string
  submissionId?: string
  chatSessionId?: string
}
export type UpdateLeadInput = Partial<LeadFormValues>

export interface LeadRepository {
  list(organizationId: string): Promise<Lead[]>
  get(organizationId: string, id: string): Promise<Lead | undefined>
  getByChatSessionId(organizationId: string, sessionId: string): Promise<Lead | undefined>
  create(input: CreateLeadInput): Promise<Lead>
  update(organizationId: string, id: string, patch: UpdateLeadInput): Promise<Lead>
  remove(organizationId: string, id: string): Promise<void>
  /**
   * Create-or-update a lead by chatSessionId in one call, used by
   * qualification-service.ts. Exists as its own interface method (rather
   * than qualification-service.ts doing list-then-write itself) so the
   * Supabase implementation can make the create-or-update decision atomic
   * via a real upsert — a list-then-write pattern was only ever safe when
   * each browser had an isolated localStorage store. organizationId is
   * taken as an explicit parameter (not read from input.organizationId)
   * because the anonymous public chat page calls this without ever having
   * "an active organization" of its own — see entities/chat/qualification-service.ts.
   */
  upsertByChatSession(organizationId: string, sessionId: string, input: CreateLeadInput): Promise<Lead>
}

function readLeads(): Lead[] {
  const stored = readJSON<Lead[] | null>(STORAGE_KEY, null)
  if (stored) return stored
  writeJSON(STORAGE_KEY, mockLeads)
  return [...mockLeads]
}

function writeLeads(leads: Lead[]): void {
  writeJSON(STORAGE_KEY, leads)
}

function assignedToName(id: string | undefined): string | undefined {
  if (!id) return undefined
  return mockTeamMembers.find((member) => member.id === id)?.name
}

export const localStorageLeadRepository: LeadRepository = {
  async list(organizationId) {
    return readLeads().filter((lead) => lead.organizationId === organizationId)
  },

  async get(organizationId, id) {
    return readLeads().find((lead) => lead.id === id && lead.organizationId === organizationId)
  },

  async getByChatSessionId(organizationId, sessionId) {
    return readLeads().find((lead) => lead.chatSessionId === sessionId && lead.organizationId === organizationId)
  },

  async create(input) {
    const leads = readLeads()
    const now = new Date().toISOString()
    const lead: Lead = {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      company: input.company,
      position: input.position,
      source: input.source,
      status: input.status,
      score: input.score ?? 0,
      estimatedBudget: input.estimatedBudget,
      assignedTo: input.assignedTo,
      notes: input.notes,
      createdAt: now,
      lastActivityAt: now,
      activity: [
        {
          id: crypto.randomUUID(),
          message: buildCreateActivityMessage(input),
          createdAt: now,
        },
      ],
      formId: input.formId,
      submissionId: input.submissionId,
      chatSessionId: input.chatSessionId,
    }
    writeLeads([lead, ...leads])
    return lead
  },

  async update(organizationId, id, patch) {
    const leads = readLeads()
    const index = leads.findIndex((lead) => lead.id === id && lead.organizationId === organizationId)
    if (index === -1) {
      throw new Error(`No se encontró el lead ${id}.`)
    }

    const existing = leads[index]
    const now = new Date().toISOString()
    const newActivity: LeadActivityEntry[] = buildUpdateActivityMessages(existing, patch, assignedToName).map(
      (message) => ({ id: crypto.randomUUID(), message, createdAt: now }),
    )
    const updated: Lead = {
      ...existing,
      ...patch,
      lastActivityAt: now,
      activity: [...newActivity, ...existing.activity],
    }
    leads[index] = updated
    writeLeads(leads)
    return updated
  },

  async remove(organizationId, id) {
    const leads = readLeads()
    writeLeads(leads.filter((lead) => !(lead.id === id && lead.organizationId === organizationId)))
  },

  async upsertByChatSession(organizationId, sessionId, input) {
    const existing = readLeads().find(
      (lead) => lead.chatSessionId === sessionId && lead.organizationId === organizationId,
    )
    if (existing) {
      return localStorageLeadRepository.update(organizationId, existing.id, input)
    }
    return localStorageLeadRepository.create({ ...input, organizationId, chatSessionId: sessionId })
  },
}
