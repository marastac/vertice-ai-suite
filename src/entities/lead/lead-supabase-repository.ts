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
  organization_id: string
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

// Shape returned by the upsert_chat_lead() RPC (`returns leads`, see
// supabase/schema.sql) — the plain `leads` table row, with no joined
// lead_activity (that's the whole point: this RPC exists so an anonymous
// caller never needs a SELECT-gated read to get its own row back).
interface UpsertChatLeadRow {
  id: string
  organization_id: string
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
}

// Single query joins the related lead_activity rows as a nested array —
// avoids an N+1 read per lead for the activity timeline.
const LEAD_SELECT = '*, lead_activity(*)'

function fromRow(row: LeadRow): Lead {
  return {
    id: row.id,
    organizationId: row.organization_id,
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
  if ('organizationId' in input) row.organization_id = input.organizationId
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

async function createNameResolver(organizationId: string): Promise<(memberId: string | undefined) => string | undefined> {
  const members = await supabaseTeamMemberRepository.list(organizationId)
  return (memberId) => members.find((member) => member.id === memberId)?.name
}

async function insertActivity(organizationId: string, leadId: string, messages: string[]): Promise<void> {
  if (messages.length === 0) return
  const { error } = await supabase
    .from('lead_activity')
    .insert(messages.map((message) => ({ organization_id: organizationId, lead_id: leadId, message })))
  if (error) throw error
}

async function fetchById(organizationId: string, id: string): Promise<Lead> {
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_SELECT)
    .eq('organization_id', organizationId)
    .eq('id', id)
    .single()
  if (error) throw error
  return fromRow(data)
}

export const supabaseLeadRepository: LeadRepository = {
  async list(organizationId) {
    const { data, error } = await supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  async get(organizationId, id) {
    const { data, error } = await supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return data ? fromRow(data) : undefined
  },

  async getByChatSessionId(organizationId, sessionId) {
    const { data, error } = await supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('organization_id', organizationId)
      .eq('chat_session_id', sessionId)
      .maybeSingle()
    if (error) throw error
    return data ? fromRow(data) : undefined
  },

  async create(input) {
    const row = buildRow(input)
    row.last_activity_at = new Date().toISOString()

    const { data: inserted, error } = await supabase.from('leads').insert(row).select('id').single()
    if (error) throw error

    await insertActivity(input.organizationId, inserted.id, [buildCreateActivityMessage(input)])
    return fetchById(input.organizationId, inserted.id)
  },

  async update(organizationId, id, patch) {
    const existing = await fetchById(organizationId, id)
    const resolveName = await createNameResolver(organizationId)
    const messages = buildUpdateActivityMessages(existing, patch, resolveName)

    const row = buildRow(patch)
    row.last_activity_at = new Date().toISOString()

    const { error } = await supabase.from('leads').update(row).eq('organization_id', organizationId).eq('id', id)
    if (error) throw error

    await insertActivity(organizationId, id, messages)
    return fetchById(organizationId, id)
  },

  async remove(organizationId, id) {
    // lead_activity rows cascade-delete via the FK's ON DELETE CASCADE.
    const { error } = await supabase.from('leads').delete().eq('organization_id', organizationId).eq('id', id)
    if (error) throw error
  },

  /**
   * Calls the upsert_chat_lead() Postgres RPC (see supabase/schema.sql)
   * instead of a plain PostgREST upsert + read-back. The public chat page
   * (/c/:orgSlug) is an anonymous `anon`-role caller, and leads_select /
   * lead_activity_select are gated by is_org_member(organization_id) —
   * unconditionally false with no auth.uid() — so a plain upsert followed
   * by a SELECT could never read back the row it had just written (the bug
   * this RPC fixes). A client-generated id (the trick create() uses) isn't
   * an option here: this is a real upsert, and a client-chosen id would
   * clobber the existing row's primary key on a conflict-UPDATE. The RPC
   * does the upsert, the lead_activity insert, and the read inside one
   * `security definer` call server-side, and returns exactly the single row
   * this call just wrote — it grants no broader read access than the
   * anonymous caller already had via leads_insert/leads_update.
   */
  async upsertByChatSession(organizationId, sessionId, input) {
    const { data, error } = await supabase.rpc('upsert_chat_lead', {
      p_organization_id: organizationId,
      p_chat_session_id: sessionId,
      p_name: input.name,
      p_email: input.email,
      p_phone: input.phone ?? null,
      p_company: input.company,
      p_status: input.status,
      p_score: input.score ?? 0,
      p_notes: input.notes ?? null,
    })
    if (error) throw error

    const row = data as UpsertChatLeadRow
    return {
      id: row.id,
      organizationId: row.organization_id,
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
      // The RPC persists the correct lead_activity row server-side, but an
      // anonymous caller still can't SELECT lead_activity back to hydrate a
      // full history here. Safe: qualification-service.ts (the only caller
      // of this method, on the anonymous public chat path) only reads
      // `.id` off the result — no anonymous UI ever renders this object's
      // activity list.
      activity: [],
      formId: row.form_id ?? undefined,
      submissionId: row.submission_id ?? undefined,
      chatSessionId: row.chat_session_id ?? undefined,
    }
  },
}
