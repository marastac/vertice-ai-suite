import { supabase } from '@/shared/lib/supabase-client'
import type { SubmissionRepository } from './submission-repository'
import type { FormSubmission, FormSubmissionAnswer } from './types'

interface SubmissionRow {
  id: string
  organization_id: string
  form_id: string
  answers: FormSubmissionAnswer[]
  score: number
  lead_id: string | null
  submitted_at: string
}

function fromRow(row: SubmissionRow): FormSubmission {
  return {
    id: row.id,
    organizationId: row.organization_id,
    formId: row.form_id,
    answers: row.answers,
    score: row.score,
    leadId: row.lead_id ?? undefined,
    submittedAt: row.submitted_at,
  }
}

export const supabaseSubmissionRepository: SubmissionRepository = {
  async listAll(organizationId) {
    const { data, error } = await supabase
      .from('form_submissions')
      .select('*')
      .eq('organization_id', organizationId)
      .order('submitted_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  async listByForm(organizationId, formId) {
    const { data, error } = await supabase
      .from('form_submissions')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('form_id', formId)
      .order('submitted_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  /**
   * Deliberately never reads `form_submissions` back after inserting — same
   * reasoning as entities/lead/lead-supabase-repository.ts::create(): this
   * runs as an anonymous `anon`-role request from a public form submission,
   * and form_submissions_select (is_org_member(organization_id)) is
   * unconditionally false with no auth.uid(). id/submittedAt are minted
   * client-side (by the caller, or here, if not supplied) and the returned
   * FormSubmission is built from data we already have, never from a
   * SELECT-gated round trip.
   */
  async create(input) {
    const id = input.id ?? crypto.randomUUID()
    const submittedAt = input.submittedAt ?? new Date().toISOString()

    const row: Record<string, unknown> = {
      id,
      organization_id: input.organizationId,
      form_id: input.formId,
      answers: input.answers,
      score: input.score,
      lead_id: input.leadId ?? null,
      submitted_at: submittedAt,
    }

    const { error } = await supabase.from('form_submissions').insert(row)
    if (error) throw error

    return {
      id,
      organizationId: input.organizationId,
      formId: input.formId,
      answers: input.answers,
      score: input.score,
      leadId: input.leadId,
      submittedAt,
    }
  },
}
