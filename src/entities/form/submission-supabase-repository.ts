import { supabase } from '@/shared/lib/supabase-client'
import type { SubmissionRepository } from './submission-repository'
import type { FormSubmission, FormSubmissionAnswer } from './types'

interface SubmissionRow {
  id: string
  form_id: string
  answers: FormSubmissionAnswer[]
  score: number
  lead_id: string | null
  submitted_at: string
}

function fromRow(row: SubmissionRow): FormSubmission {
  return {
    id: row.id,
    formId: row.form_id,
    answers: row.answers,
    score: row.score,
    leadId: row.lead_id ?? undefined,
    submittedAt: row.submitted_at,
  }
}

export const supabaseSubmissionRepository: SubmissionRepository = {
  async listAll() {
    const { data, error } = await supabase.from('form_submissions').select('*').order('submitted_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  async listByForm(formId) {
    const { data, error } = await supabase
      .from('form_submissions')
      .select('*')
      .eq('form_id', formId)
      .order('submitted_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  async create(input) {
    // A caller-supplied id/submittedAt matters: submission-service.ts mints
    // the submission id up front and stamps it onto the Lead it creates
    // FIRST, before this FormSubmission row exists — see leads.submission_id
    // having no FK constraint in supabase/schema.sql for why.
    const row: Record<string, unknown> = {
      form_id: input.formId,
      answers: input.answers,
      score: input.score,
      lead_id: input.leadId ?? null,
    }
    if (input.id) row.id = input.id
    if (input.submittedAt) row.submitted_at = input.submittedAt

    const { data, error } = await supabase.from('form_submissions').insert(row).select('*').single()
    if (error) throw error
    return fromRow(data)
  },
}
