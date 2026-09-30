import { dataBackend } from '@/shared/lib/data-backend'
import { activeLeadRepository } from '@/entities/lead'
import { submitPublicForm } from './api-client'
import { activeFormRepository } from './active-form-repository'
import { activeSubmissionRepository } from './active-submission-repository'
import { computeSubmissionScore, scoreToLeadStatus } from './scoring'
import type { FormQuestion, FormSubmission, FormSubmissionAnswer } from './types'

function findAnswerValue(
  questions: FormQuestion[],
  answers: FormSubmissionAnswer[],
  predicate: (question: FormQuestion) => boolean,
): string | undefined {
  const question = questions.find(predicate)
  if (!question) return undefined
  const answer = answers.find((item) => item.questionId === question.id)
  if (!answer || typeof answer.value !== 'string') return undefined
  const trimmed = answer.value.trim()
  return trimmed === '' ? undefined : trimmed
}

function mapAnswersToLeadFields(questions: FormQuestion[], answers: FormSubmissionAnswer[]) {
  const email = findAnswerValue(questions, answers, (question) => question.type === 'email')
  const phone = findAnswerValue(questions, answers, (question) => question.type === 'phone')
  const name = findAnswerValue(questions, answers, (question) => /nombre/i.test(question.label)) ?? 'Lead sin nombre'
  const company =
    findAnswerValue(questions, answers, (question) => /(empresa|compañ|compan)/i.test(question.label)) ?? 'Sin empresa'

  if (!email) {
    throw new Error('El formulario no tiene una pregunta de correo electrónico configurada.')
  }

  return { name, email, phone, company }
}

export interface SubmitQualificationFormResult {
  submission: FormSubmission
  leadId: string
  organizationId: string
}

/**
 * `honeypot` defaults to '' (never triggers) so every existing caller that
 * doesn't know about it keeps working unchanged.
 *
 * Fase C hardening branches on `dataBackend`:
 *   - `supabase`: delegates entirely to the backend (submitPublicForm() →
 *     POST /api/forms/:formId/submissions) — the browser no longer writes
 *     leads/form_submissions/lead_activity directly at all. See
 *     server/src/services/form-submission-service.ts for the full
 *     server-side validation/scoring/write sequence this replaces.
 *   - `local`: UNCHANGED from before Fase C — forms/leads/submissions in
 *     local mode live entirely in this browser's own localStorage, which
 *     the Express backend has no access to and must never be routed
 *     through. This hardening targets Supabase's real, unauthenticated
 *     REST API attack surface specifically; local mode never had one.
 */
export async function submitQualificationForm(
  formId: string,
  answers: FormSubmissionAnswer[],
  honeypot = '',
): Promise<SubmitQualificationFormResult> {
  if (dataBackend === 'supabase') {
    const result = await submitPublicForm(formId, answers, honeypot)
    return {
      submission: {
        id: result.submissionId,
        organizationId: result.organizationId,
        formId,
        answers,
        score: result.score,
        leadId: result.leadId,
        submittedAt: result.submittedAt,
      },
      leadId: result.leadId,
      organizationId: result.organizationId,
    }
  }

  // Public, org-agnostic lookup — the visitor submitting this form was never
  // a member of any organization. The form row itself carries the
  // organizationId every downstream write below needs.
  const form = await activeFormRepository.getPublic(formId)
  if (!form) {
    throw new Error('Formulario no encontrado.')
  }
  if (form.status !== 'active') {
    throw new Error('Este formulario no está activo.')
  }

  const submissionId = crypto.randomUUID()
  const score = computeSubmissionScore(form.questions, answers)
  const status = scoreToLeadStatus(score)
  const { name, email, phone, company } = mapAnswersToLeadFields(form.questions, answers)

  const lead = await activeLeadRepository.create({
    organizationId: form.organizationId,
    name,
    email,
    phone,
    company,
    source: 'form',
    status,
    score,
    notes: `Lead generado automáticamente a través del formulario "${form.name}".`,
    formId: form.id,
    submissionId,
  })

  const submission = await activeSubmissionRepository.create({
    id: submissionId,
    organizationId: form.organizationId,
    formId: form.id,
    answers,
    score,
    leadId: lead.id,
  })

  return { submission, leadId: lead.id, organizationId: form.organizationId }
}
