import { activeLeadRepository } from '@/entities/lead'
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

export async function submitQualificationForm(
  formId: string,
  answers: FormSubmissionAnswer[],
): Promise<SubmitQualificationFormResult> {
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
