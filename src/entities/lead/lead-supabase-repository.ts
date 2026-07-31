import { supabaseTeamMemberRepository } from '@/entities/team-member'
import { supabase } from '@/shared/lib/supabase-client'
import { buildCreateActivityMessage, buildUpdateActivityMessages } from './lead-activity'
import type { CreateLeadInput, LeadRepository } from './lead-repository'
import type { Lead, LeadActivityEntry } from './types'

interface LeadActivityRow {
  id: string
  message: string
  created_at: string
}

interface LeadRow {
  id: string
  name: string
  email: string
  phone: string | null
  company: string
  position: string | null
  source: Lead['source']
  status: Lead['status']
  score: number
  estimated_budget: number | null
  assigned_to: string | null
  notes: string | null
  form_id: string | null
  submission_id: string | null
  chat_session_id: string | null
  created_at: string
  last_activity_at: string
  lead_activity: LeadActivityRow[]
}

// Single query joins the related lead_activity rows as a nested array —
// avoids an N+1 read per lead for the activity timeline.
const LEAD_SELECT = '*, lead_activity(*)'

function fromRow(row: LeadRow): Lead {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? undefined,
    company: row.company,
    position: row.position ?? undefined,
    source: row.source,
    status: row.status,
    score: row.score,
    estimatedBudget: row.estimated_budget ?? undefined,
    assignedTo: row.assigned_to ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    // Newest first, matching the app's existing display convention (see
    // lead-repository.ts's update(), which prepends new entries).
    activity: row.lead_activity
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((entry): LeadActivityEntry => ({ id: entry.id, message: entry.message, createdAt: entry.created_at })),
    formId: row.form_id ?? undefined,
    submissionId: row.submission_id ?? undefined,
    chatSessionId: row.chat_session_id ?? undefined,
  }
}

/**
 * Builds a partial DB row from a partial CreateLeadInput/UpdateLeadInput,
 * including a column only when the caller's object actually has that key.
 * This is what makes both create() (a plain insert, where omit-vs-null
 * produces the same result) and upsertByChatSession() (a real upsert,
 * where an omitted key leaves the existing column untouched on conflict
 * instead of overwriting it) safe to share this one function — see
 * upsertByChatSession() for why that distinction matters.
 */
function buildRow(input: Partial<CreateLeadInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  if ('name' in input) row.name = input.name
  if ('email' in input) row.email = input.email
  if ('phone' in input) row.phone = input.phone ?? null
  if ('company' in input) row.company = input.company
  if ('position' in input) row.position = input.position ?? null
  if ('source' in input) row.source = input.source
  if ('status' in input) row.status = input.status
  if ('score' in input) row.score = input.score ?? 0
  if ('estimatedBudget' in input) row.estimated_budget = input.estimatedBudget ?? null
  if ('assignedTo' in input) row.assigned_to = input.assignedTo || null
  if ('notes' in input) row.notes = input.notes ?? null
  if ('formId' in input) row.form_id = input.formId ?? null
  if ('submissionId' in input) row.submission_id = input.submissionId ?? null
  if ('chatSessionId' in input) row.chat_session_id = input.chatSessionId ?? null
  return row
}

async function createNameResolver(): Promise<(memberId: string | undefined) => string | undefined> {
  const members = await supabaseTeamMemberRepository.list()
  return (memberId) => members.find((member) => member.id === memberId)?.name
}

async function insertActivity(leadId: string, messages: string[]): Promise<void> {
  if (messages.length === 0) return
  const { error } = await supabase.from('lead_activity').insert(messages.map((message) => ({ lead_id: leadId, message })))
  if (error) throw error
}

async function fetchById(id: string): Promise<Lead> {
  const { data, error } = await supabase.from('leads').select(LEAD_SELECT).eq('id', id).single()
  if (error) throw error
  return fromRow(data)
}

export const supabaseLeadRepository: LeadRepository = {
  async list() {
    const { data, error } = await supabase.from('leads').select(LEAD_SELECT).order('created_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  async get(id) {
    const { data, error } = await supabase.from('leads').select(LEAD_SELECT).eq('id', id).maybeSingle()
    if (error) throw error
    return data ? fromRow(data) : undefined
  },

  async getByChatSessionId(sessionId) {
    const { data, error } = await supabase.from('leads').select(LEAD_SELECT).eq('chat_session_id', sessionId).maybeSingle()
    if (error) throw error
    return data ? fromRow(data) : undefined
  },

  async create(input) {
    const row = buildRow(input)
    row.last_activity_at = new Date().toISOString()

    const { data: inserted, error } = await supabase.from('leads').insert(row).select('id').single()
    if (error) throw error

    await insertActivity(inserted.id, [buildCreateActivityMessage(input)])
    return fetchById(inserted.id)
  },

  async update(id, patch) {
    const existing = await fetchById(id)
    const resolveName = await createNameResolver()
    const messages = buildUpdateActivityMessages(existing, patch, resolveName)

    const row = buildRow(patch)
    row.last_activity_at = new Date().toISOString()

    const { error } = await supabase.from('leads').update(row).eq('id', id)
    if (error) throw error

    await insertActivity(id, messages)
    return fetchById(id)
  },

  async remove(id) {
    // lead_activity rows cascade-delete via the FK's ON DELETE CASCADE.
    const { error } = await supabase.from('leads').delete().eq('id', id)
    if (error) throw error
  },

  async upsertByChatSession(sessionId, input) {
    // Best-effort read, used only to decide which activity message(s) to
    // log — NOT what makes this race-free. Race-freedom comes from the
    // upsert below, backed by the partial unique index on
    // leads.chat_session_id (see supabase/schema.sql): whichever of two
    // concurrent calls resolves second still lands on the same row via ON
    // CONFLICT, so at most one lead ever exists per chat session even if
    // this read is stale by the time the upsert runs. Worst case under an
    // actual race is an imprecise activity log line, never a duplicate lead.
    const existing = await supabaseLeadRepository.getByChatSessionId(sessionId)

    const row = buildRow(input)
    row.chat_session_id = sessionId
    row.last_activity_at = new Date().toISOString()

    const { error } = await supabase.from('leads').upsert(row, { onConflict: 'chat_session_id' })
    if (error) throw error

    const result = await supabaseLeadRepository.getByChatSessionId(sessionId)
    if (!result) throw new Error(`No se encontró el lead para la sesión de chat ${sessionId} tras el upsert.`)

    if (existing) {
      const resolveName = await createNameResolver()
      await insertActivity(result.id, buildUpdateActivityMessages(existing, input, resolveName))
    } else {
      await insertActivity(result.id, [buildCreateActivityMessage({ ...input, chatSessionId: sessionId })])
    }

    return fetchById(result.id)
  },
}
