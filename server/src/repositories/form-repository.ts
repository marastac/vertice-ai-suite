import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../lib/supabase-client.js'
import { logger } from '../lib/logger.js'
import type { FormQuestion } from '../schemas/forms.js'

export interface PublicForm {
  id: string
  organizationId: string
  name: string
  status: 'draft' | 'active'
  questions: FormQuestion[]
}

/**
 * Same three-state shape as organization-lookup.ts/chat-config-repository.ts,
 * for the same reason: a genuine Supabase query FAILURE must never be
 * reported as "this form doesn't exist" — callers (form-submission-service.ts)
 * treat the two very differently (a permanent 404 vs. a retryable 503).
 */
export type PublicFormLookup = { status: 'found'; form: PublicForm } | { status: 'not_found' } | { status: 'unavailable' }

interface FormRow {
  id: string
  organization_id: string
  name: string
  status: 'draft' | 'active'
  // jsonb column — already stored as the camelCase FormQuestion[] shape
  // (see src/entities/form/form-supabase-repository.ts's identical
  // fromRow() for the frontend's own read of this same column), never
  // snake_case. Admin-authored via formBuilderSchema (already Zod-validated
  // at write time from /forms), so a light cast here is consistent with how
  // every other server-side Supabase row mapper in this backend (
  // organization-lookup.ts, chat-config-repository.ts) already trusts its
  // own columns without re-validating their internal shape.
  questions: FormQuestion[]
}

// Same native .abortSignal(AbortSignal.timeout(...)) mechanism and constant
// as chat-config-repository.ts/usage-events-repository.ts — this query
// gates whether a public form submission can proceed at all, so a hung
// Supabase response must never leave the request pending indefinitely.
const FORM_QUERY_TIMEOUT_MS = 5_000

/**
 * Loads the real `forms` row for `formId` via `supabaseAdmin` (service_role
 * — bypasses RLS; the same credential organization-lookup.ts/
 * chat-config-repository.ts/usage-events-repository.ts already use
 * server-side, no new credential). This is the ONLY source of truth for
 * `organization_id`, `status`, and the real `questions` a public form
 * submission is validated/scored against — never anything the client sends.
 */
export async function loadPublicForm(formId: string): Promise<PublicFormLookup> {
  if (!supabaseAdmin) {
    // Defensive only — routes/forms.ts already returns 503 before calling
    // this if supabaseAdmin isn't configured (see its own comment on why
    // there is no 'local' equivalent server-side, unlike organization-lookup.ts's
    // not_configured — see the implementation report for the full reasoning).
    return { status: 'unavailable' }
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('forms')
      .select('id, organization_id, name, status, questions')
      .eq('id', formId)
      .abortSignal(AbortSignal.timeout(FORM_QUERY_TIMEOUT_MS))
      .maybeSingle()

    if (error) {
      logger.warn('Could not load form for public submission — treating as temporarily unavailable', { message: error.message })
      return { status: 'unavailable' }
    }
    if (!data) {
      return { status: 'not_found' }
    }

    const row = data as FormRow
    return {
      status: 'found',
      form: { id: row.id, organizationId: row.organization_id, name: row.name, status: row.status, questions: row.questions },
    }
  } catch (error) {
    logger.warn('Could not load form for public submission — treating as temporarily unavailable', {
      message: error instanceof Error ? error.message : String(error),
    })
    return { status: 'unavailable' }
  }
}

export interface InsertLeadInput {
  organizationId: string
  name: string
  email: string
  phone?: string
  company: string
  score: number
  status: string
  notes: string
  formId: string
  submissionId: string
}

/**
 * Inserts the real `leads` row via service_role. Deliberately THROWS on
 * failure (unlike usage-events-repository.ts's best-effort contract) — a
 * failed lead write here is not a lost metering event, it's the actual
 * result the visitor is waiting on; the route's outer try/catch turns this
 * into a calm, generic error response, exactly as the old client-side
 * `.insert()` failure already did in submission-service.ts before Fase C.
 */
export async function insertLead(input: InsertLeadInput): Promise<string> {
  if (!supabaseAdmin) {
    throw new Error('Supabase no está configurado en el servidor.')
  }
  const id = randomUUID()
  const { error } = await supabaseAdmin.from('leads').insert({
    id,
    organization_id: input.organizationId,
    name: input.name,
    email: input.email,
    phone: input.phone ?? null,
    company: input.company,
    source: 'form',
    status: input.status,
    score: input.score,
    notes: input.notes,
    form_id: input.formId,
    submission_id: input.submissionId,
  })
  if (error) throw error
  return id
}

/** Exactly one call per submission — see form-submission-service.ts. */
export async function insertLeadActivity(organizationId: string, leadId: string, message: string): Promise<void> {
  if (!supabaseAdmin) {
    throw new Error('Supabase no está configurado en el servidor.')
  }
  const { error } = await supabaseAdmin.from('lead_activity').insert({ organization_id: organizationId, lead_id: leadId, message })
  if (error) throw error
}

export interface InsertFormSubmissionInput {
  id: string
  organizationId: string
  formId: string
  answers: unknown
  score: number
  leadId: string
}

export async function insertFormSubmission(input: InsertFormSubmissionInput): Promise<void> {
  if (!supabaseAdmin) {
    throw new Error('Supabase no está configurado en el servidor.')
  }
  const { error } = await supabaseAdmin.from('form_submissions').insert({
    id: input.id,
    organization_id: input.organizationId,
    form_id: input.formId,
    answers: input.answers,
    score: input.score,
    lead_id: input.leadId,
  })
  if (error) throw error
}
