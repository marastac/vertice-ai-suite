import { randomUUID } from 'node:crypto'
import { AppError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { insertFormSubmission, insertLead, insertLeadActivity, loadPublicForm } from '../repositories/form-repository.js'
import { computeSubmissionScore, scoreToLeadStatus } from './form-scoring.js'
import type { FormQuestion, FormSubmissionAnswerInput } from '../schemas/forms.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function findAnswer(answers: FormSubmissionAnswerInput[], questionId: string): FormSubmissionAnswerInput | undefined {
  return answers.find((item) => item.questionId === questionId)
}

function isEmptyAnswerValue(value: string | string[] | undefined): boolean {
  if (value === undefined) return true
  return Array.isArray(value) ? value.length === 0 : value.trim() === ''
}

/**
 * Semantic validation against the REAL question definitions loaded from
 * `forms.questions` — required fields present, value shape matches the
 * question type, and for choice-type questions every selected option id
 * genuinely exists on that question. This is the layer Zod's static schema
 * (submitPublicFormBodySchema) can't express, because it depends on data
 * only known at request time (the real form). An answer whose questionId
 * doesn't match any real question on this form is silently ignored, never
 * an error — Zod already capped how many answers/how long each can be
 * (see schemas/forms.ts); this only validates ones that map to a real
 * question. Throws AppError(400, ...) on the first problem found — mirrors
 * the client-side validateFormAnswers()'s per-question checks
 * (src/entities/form/validate-answers.ts), now enforced where a direct
 * client can't bypass it.
 */
function validateAnswersAgainstForm(questions: FormQuestion[], answers: FormSubmissionAnswerInput[]): void {
  for (const question of questions) {
    const answer = findAnswer(answers, question.id)
    const empty = isEmptyAnswerValue(answer?.value)

    if (question.required && empty) {
      throw new AppError(400, `Falta responder: "${question.label}".`)
    }
    if (empty) continue

    const value = answer!.value

    if (question.type === 'email') {
      if (typeof value !== 'string' || !EMAIL_PATTERN.test(value.trim())) {
        throw new AppError(400, `El correo electrónico de "${question.label}" no es válido.`)
      }
    }

    if (question.type === 'phone') {
      if (typeof value !== 'string' || value.trim().length < 6) {
        throw new AppError(400, `El teléfono de "${question.label}" no es válido.`)
      }
    }

    if (question.type === 'number') {
      if (typeof value !== 'string' || Number.isNaN(Number(value))) {
        throw new AppError(400, `"${question.label}" debe ser un número.`)
      }
    }

    if (question.type === 'single_choice' || question.type === 'yes_no') {
      const validIds = new Set((question.options ?? []).map((option) => option.id))
      if (typeof value !== 'string' || !validIds.has(value)) {
        throw new AppError(400, `La opción seleccionada en "${question.label}" no es válida.`)
      }
    }

    if (question.type === 'multiple_choice') {
      const validIds = new Set((question.options ?? []).map((option) => option.id))
      const values = Array.isArray(value) ? value : []
      if (values.length === 0 || !values.every((id) => validIds.has(id))) {
        throw new AppError(400, `Alguna opción seleccionada en "${question.label}" no es válida.`)
      }
    }
  }
}

function findAnswerValue(
  questions: FormQuestion[],
  answers: FormSubmissionAnswerInput[],
  predicate: (question: FormQuestion) => boolean,
): string | undefined {
  const question = questions.find(predicate)
  if (!question) return undefined
  const answer = answers.find((item) => item.questionId === question.id)
  if (!answer || typeof answer.value !== 'string') return undefined
  const trimmed = answer.value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Exact backend port of submission-service.ts's mapAnswersToLeadFields() — same field-detection rules, same defaults. */
function deriveLeadFields(questions: FormQuestion[], answers: FormSubmissionAnswerInput[]) {
  const email = findAnswerValue(questions, answers, (question) => question.type === 'email')
  const phone = findAnswerValue(questions, answers, (question) => question.type === 'phone')
  const name = findAnswerValue(questions, answers, (question) => /nombre/i.test(question.label)) ?? 'Lead sin nombre'
  const company =
    findAnswerValue(questions, answers, (question) => /(empresa|compañ|compan)/i.test(question.label)) ?? 'Sin empresa'

  if (!email) {
    throw new AppError(400, 'El formulario no tiene una pregunta de correo electrónico configurada.')
  }

  return { name, email, phone, company }
}

export interface PublicFormSubmissionResult {
  submissionId: string
  leadId: string
  organizationId: string
  score: number
  status: string
  submittedAt: string
}

/**
 * Orchestrates one public form submission end-to-end, entirely server-side:
 * loads the real form (organization_id/status/questions), validates the
 * client's answers against it, computes score/status, derives contact
 * fields, and performs the three writes (lead, exactly one lead_activity,
 * form_submission) via service_role. The client sends ONLY `answers` and
 * the honeypot value — `organizationId`, `score`, `status`, `source`, and
 * every other authority field are decided HERE, never accepted from the
 * request (see schemas/forms.ts's `.strict()` schemas, which reject a
 * request carrying any of them at all).
 *
 * Honeypot handling: a filled honeypot returns a normal-looking success
 * response WITHOUT ever touching Supabase — the ids in that response are
 * freshly minted but never persisted anywhere, purely to keep the response
 * shape consistent for the (automated) caller. Never reveals the trap via a
 * different status code or error message.
 */
export async function createPublicFormSubmission(
  formId: string,
  answers: FormSubmissionAnswerInput[],
  honeypotValue: string | undefined,
): Promise<PublicFormSubmissionResult> {
  const lookup = await loadPublicForm(formId)

  if (lookup.status === 'not_found') {
    throw new AppError(404, 'Formulario no encontrado.')
  }
  if (lookup.status === 'unavailable') {
    throw new AppError(503, 'No se pudo cargar el formulario en este momento. Inténtalo de nuevo.')
  }

  const form = lookup.form
  if (form.status !== 'active') {
    throw new AppError(403, 'Este formulario no está activo.')
  }

  if (honeypotValue && honeypotValue.trim() !== '') {
    logger.warn('Public form submission rejected by honeypot', { formId })
    return {
      submissionId: randomUUID(),
      leadId: randomUUID(),
      organizationId: form.organizationId,
      score: 0,
      status: 'disqualified',
      submittedAt: new Date().toISOString(),
    }
  }

  validateAnswersAgainstForm(form.questions, answers)

  const score = computeSubmissionScore(form.questions, answers)
  const status = scoreToLeadStatus(score)
  const { name, email, phone, company } = deriveLeadFields(form.questions, answers)

  const submissionId = randomUUID()
  const notes = `Lead generado automáticamente a través del formulario "${form.name}".`

  const leadId = await insertLead({
    organizationId: form.organizationId,
    name,
    email,
    phone,
    company,
    score,
    status,
    notes,
    formId: form.id,
    submissionId,
  })

  // Exactly one activity entry per submission — mirrors
  // src/entities/lead/lead-activity.ts::buildCreateActivityMessage()'s exact
  // wording for a form-originated lead, so the dashboard timeline reads
  // identically regardless of which code path created it.
  await insertLeadActivity(form.organizationId, leadId, 'Lead creado automáticamente desde un formulario.')

  await insertFormSubmission({
    id: submissionId,
    organizationId: form.organizationId,
    formId: form.id,
    answers,
    score,
    leadId,
  })

  return {
    submissionId,
    leadId,
    organizationId: form.organizationId,
    score,
    status,
    submittedAt: new Date().toISOString(),
  }
}
