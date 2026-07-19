import { mockTeamMembers } from '@/entities/team-member'
import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { mockLeads } from './mock-data'
import { leadStatusLabel } from './presentation'
import type { LeadFormValues } from './schema'
import type { Lead, LeadActivityEntry } from './types'

const STORAGE_KEY = 'lead-ai:leads:v1'

export type CreateLeadInput = LeadFormValues & { formId?: string; submissionId?: string }
export type UpdateLeadInput = Partial<LeadFormValues>

export interface LeadRepository {
  list(): Promise<Lead[]>
  get(id: string): Promise<Lead | undefined>
  create(input: CreateLeadInput): Promise<Lead>
  update(id: string, patch: UpdateLeadInput): Promise<Lead>
  remove(id: string): Promise<void>
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

function buildUpdateActivity(existing: Lead, patch: UpdateLeadInput, now: string): LeadActivityEntry[] {
  const entries: LeadActivityEntry[] = []

  if (patch.status && patch.status !== existing.status) {
    entries.push({
      id: crypto.randomUUID(),
      message: `Estado actualizado a "${leadStatusLabel[patch.status]}".`,
      createdAt: now,
    })
  }

  if ('assignedTo' in patch && patch.assignedTo !== existing.assignedTo) {
    const name = assignedToName(patch.assignedTo)
    entries.push({
      id: crypto.randomUUID(),
      message: name ? `Lead asignado a ${name}.` : 'Se ha quitado la persona asignada.',
      createdAt: now,
    })
  }

  const contactFieldsChanged = (
    ['name', 'email', 'phone', 'company', 'position', 'source', 'estimatedBudget', 'notes', 'score'] as const
  ).some((field) => field in patch && patch[field] !== existing[field])

  if (contactFieldsChanged) {
    entries.push({ id: crypto.randomUUID(), message: 'Información del lead actualizada.', createdAt: now })
  }

  return entries
}

export const localStorageLeadRepository: LeadRepository = {
  async list() {
    return readLeads()
  },

  async get(id) {
    return readLeads().find((lead) => lead.id === id)
  },

  async create(input) {
    const leads = readLeads()
    const now = new Date().toISOString()
    const lead: Lead = {
      id: crypto.randomUUID(),
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
          message: input.formId ? 'Lead creado automáticamente desde un formulario.' : 'Lead creado manualmente por el equipo.',
          createdAt: now,
        },
      ],
      formId: input.formId,
      submissionId: input.submissionId,
    }
    writeLeads([lead, ...leads])
    return lead
  },

  async update(id, patch) {
    const leads = readLeads()
    const index = leads.findIndex((lead) => lead.id === id)
    if (index === -1) {
      throw new Error(`No se encontró el lead ${id}.`)
    }

    const existing = leads[index]
    const now = new Date().toISOString()
    const newActivity = buildUpdateActivity(existing, patch, now)
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

  async remove(id) {
    const leads = readLeads()
    writeLeads(leads.filter((lead) => lead.id !== id))
  },
}
