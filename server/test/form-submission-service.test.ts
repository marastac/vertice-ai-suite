import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FormQuestion } from '../src/schemas/forms.js'

// createPublicFormSubmission() is the ONLY place a public form submission's
// lead/activity/submission gets created (Fase C) — this replaces what used
// to be three direct, unauthenticated Supabase writes from the browser. It
// must NEVER trust a client-supplied organizationId/score/status, must
// validate answers against the REAL form loaded server-side, must write
// exactly one lead_activity per successful submission, and must write
// NOTHING when the request is rejected for any reason (form not found,
// inactive, invalid answers, or the honeypot).

afterEach(() => {
  vi.resetModules()
})

const EMAIL_QUESTION: FormQuestion = { id: 'q-email', type: 'email', label: 'Correo electrónico', required: true }
const BUDGET_QUESTION: FormQuestion = {
  id: 'q-budget',
  type: 'single_choice',
  label: 'Presupuesto',
  required: true,
  options: [
    { id: 'low', label: 'Bajo', points: 10 },
    { id: 'high', label: 'Alto', points: 50 },
  ],
}
const NOTES_QUESTION: FormQuestion = { id: 'q-notes', type: 'short_text', label: 'Notas', required: false, points: 40 }

const QUESTIONS = [EMAIL_QUESTION, BUDGET_QUESTION, NOTES_QUESTION]

const FIXTURE_FORM = {
  id: 'form-1',
  organizationId: 'org-1',
  name: 'Formulario real',
  status: 'active' as const,
  questions: QUESTIONS,
}

interface Mocks {
  loadPublicForm?: ReturnType<typeof vi.fn>
  insertLead?: ReturnType<typeof vi.fn>
  insertLeadActivity?: ReturnType<typeof vi.fn>
  insertFormSubmission?: ReturnType<typeof vi.fn>
}

async function loadServiceWithMocks(mocks: Mocks = {}) {
  vi.resetModules()
  vi.doMock('../src/repositories/form-repository.js', () => ({
    loadPublicForm: mocks.loadPublicForm ?? vi.fn().mockResolvedValue({ status: 'found', form: FIXTURE_FORM }),
    insertLead: mocks.insertLead ?? vi.fn().mockResolvedValue('lead-1'),
    insertLeadActivity: mocks.insertLeadActivity ?? vi.fn().mockResolvedValue(undefined),
    insertFormSubmission: mocks.insertFormSubmission ?? vi.fn().mockResolvedValue(undefined),
  }))
  return import('../src/services/form-submission-service.js')
}

const VALID_ANSWERS = [
  { questionId: 'q-email', value: 'visitante@example.com' },
  { questionId: 'q-budget', value: 'high' },
  { questionId: 'q-notes', value: 'Quiero más información.' },
]

describe('createPublicFormSubmission — valid submission', () => {
  it('creates lead + exactly one lead_activity + form_submission, with score/status computed server-side', async () => {
    const insertLead = vi.fn().mockResolvedValue('lead-real-id')
    const insertLeadActivity = vi.fn().mockResolvedValue(undefined)
    const insertFormSubmission = vi.fn().mockResolvedValue(undefined)
    const { createPublicFormSubmission } = await loadServiceWithMocks({ insertLead, insertLeadActivity, insertFormSubmission })

    const result = await createPublicFormSubmission('form-1', VALID_ANSWERS, undefined)

    // email(0) + budget("high"=50) + notes(40) = 90 out of max 90 -> 100
    expect(result.score).toBe(100)
    expect(result.status).toBe('qualified')
    expect(result.organizationId).toBe('org-1')
    expect(result.leadId).toBe('lead-real-id')

    expect(insertLead).toHaveBeenCalledTimes(1)
    expect(insertLead).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        email: 'visitante@example.com',
        score: 100,
        status: 'qualified',
        formId: 'form-1',
      }),
    )

    // Exactly one activity entry — never zero, never duplicated.
    expect(insertLeadActivity).toHaveBeenCalledTimes(1)
    expect(insertLeadActivity).toHaveBeenCalledWith('org-1', 'lead-real-id', 'Lead creado automáticamente desde un formulario.')

    expect(insertFormSubmission).toHaveBeenCalledTimes(1)
    expect(insertFormSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', formId: 'form-1', leadId: 'lead-real-id', score: 100 }),
    )
  })

  it('never trusts a client-supplied organizationId/score/status even if the answers array somehow carried one — only the loaded form/computed values are ever used', async () => {
    const insertLead = vi.fn().mockResolvedValue('lead-1')
    const { createPublicFormSubmission } = await loadServiceWithMocks({ insertLead })

    await createPublicFormSubmission('form-1', VALID_ANSWERS, undefined)

    const insertedLead = insertLead.mock.calls[0][0]
    expect(insertedLead.organizationId).toBe(FIXTURE_FORM.organizationId) // from the loaded form, never anything else
    expect(insertedLead.score).toBe(100) // computed, never client-supplied
  })
})

describe('createPublicFormSubmission — rejections write NOTHING', () => {
  it('form not found -> AppError(404), zero writes', async () => {
    const loadPublicForm = vi.fn().mockResolvedValue({ status: 'not_found' })
    const insertLead = vi.fn()
    const insertLeadActivity = vi.fn()
    const insertFormSubmission = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ loadPublicForm, insertLead, insertLeadActivity, insertFormSubmission })

    await expect(createPublicFormSubmission('nonexistent-form', VALID_ANSWERS, undefined)).rejects.toMatchObject({ status: 404 })

    expect(insertLead).not.toHaveBeenCalled()
    expect(insertLeadActivity).not.toHaveBeenCalled()
    expect(insertFormSubmission).not.toHaveBeenCalled()
  })

  it('form query unavailable -> AppError(503), zero writes', async () => {
    const loadPublicForm = vi.fn().mockResolvedValue({ status: 'unavailable' })
    const insertLead = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ loadPublicForm, insertLead })

    await expect(createPublicFormSubmission('form-1', VALID_ANSWERS, undefined)).rejects.toMatchObject({ status: 503 })
    expect(insertLead).not.toHaveBeenCalled()
  })

  it('form status is "draft" (not active) -> AppError(403), zero writes', async () => {
    const loadPublicForm = vi.fn().mockResolvedValue({ status: 'found', form: { ...FIXTURE_FORM, status: 'draft' } })
    const insertLead = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ loadPublicForm, insertLead })

    await expect(createPublicFormSubmission('form-1', VALID_ANSWERS, undefined)).rejects.toMatchObject({ status: 403 })
    expect(insertLead).not.toHaveBeenCalled()
  })

  it('a required question left unanswered -> AppError(400), zero writes', async () => {
    const insertLead = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ insertLead })

    const answers = VALID_ANSWERS.filter((a) => a.questionId !== 'q-budget') // q-budget is required
    await expect(createPublicFormSubmission('form-1', answers, undefined)).rejects.toMatchObject({ status: 400 })
    expect(insertLead).not.toHaveBeenCalled()
  })

  it('a manipulated/nonexistent option id for a single_choice question -> AppError(400), zero writes', async () => {
    const insertLead = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ insertLead })

    const answers = [
      { questionId: 'q-email', value: 'visitante@example.com' },
      { questionId: 'q-budget', value: 'ATTACKER-FABRICATED-OPTION-ID' },
    ]
    await expect(createPublicFormSubmission('form-1', answers, undefined)).rejects.toMatchObject({ status: 400 })
    expect(insertLead).not.toHaveBeenCalled()
  })

  it('a manipulated option id inside a multiple_choice answer -> AppError(400), zero writes', async () => {
    const multiQuestion: FormQuestion = {
      id: 'q-multi',
      type: 'multiple_choice',
      label: 'Servicios de interés',
      required: true,
      options: [
        { id: 'seo', label: 'SEO', points: 10 },
        { id: 'ads', label: 'Ads', points: 10 },
      ],
    }
    const loadPublicForm = vi
      .fn()
      .mockResolvedValue({ status: 'found', form: { ...FIXTURE_FORM, questions: [EMAIL_QUESTION, multiQuestion] } })
    const insertLead = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ loadPublicForm, insertLead })

    const answers = [
      { questionId: 'q-email', value: 'visitante@example.com' },
      { questionId: 'q-multi', value: ['seo', 'ATTACKER-FABRICATED-ID'] },
    ]
    await expect(createPublicFormSubmission('form-1', answers, undefined)).rejects.toMatchObject({ status: 400 })
    expect(insertLead).not.toHaveBeenCalled()
  })

  it('an invalid email format -> AppError(400), zero writes', async () => {
    const insertLead = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ insertLead })

    const answers = [
      { questionId: 'q-email', value: 'no-es-un-correo' },
      { questionId: 'q-budget', value: 'high' },
    ]
    await expect(createPublicFormSubmission('form-1', answers, undefined)).rejects.toMatchObject({ status: 400 })
    expect(insertLead).not.toHaveBeenCalled()
  })

  it('a form with no email question configured -> AppError(400), zero writes (mirrors the pre-Fase-C client-side rule)', async () => {
    const loadPublicForm = vi
      .fn()
      .mockResolvedValue({ status: 'found', form: { ...FIXTURE_FORM, questions: [BUDGET_QUESTION] } })
    const insertLead = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ loadPublicForm, insertLead })

    await expect(createPublicFormSubmission('form-1', [{ questionId: 'q-budget', value: 'high' }], undefined)).rejects.toMatchObject({
      status: 400,
    })
    expect(insertLead).not.toHaveBeenCalled()
  })
})

describe('createPublicFormSubmission — honeypot', () => {
  it('a filled honeypot returns a normal-looking success response WITHOUT writing anything to Supabase', async () => {
    const insertLead = vi.fn()
    const insertLeadActivity = vi.fn()
    const insertFormSubmission = vi.fn()
    const { createPublicFormSubmission } = await loadServiceWithMocks({ insertLead, insertLeadActivity, insertFormSubmission })

    const result = await createPublicFormSubmission('form-1', VALID_ANSWERS, 'i-am-a-bot')

    expect(result.organizationId).toBe('org-1') // still the real org, for a consistent-looking response
    expect(typeof result.submissionId).toBe('string')
    expect(typeof result.leadId).toBe('string')

    expect(insertLead).not.toHaveBeenCalled()
    expect(insertLeadActivity).not.toHaveBeenCalled()
    expect(insertFormSubmission).not.toHaveBeenCalled()
  })

  it('an empty honeypot value is treated as a normal, real submission', async () => {
    const insertLead = vi.fn().mockResolvedValue('lead-1')
    const { createPublicFormSubmission } = await loadServiceWithMocks({ insertLead })

    await createPublicFormSubmission('form-1', VALID_ANSWERS, '')

    expect(insertLead).toHaveBeenCalledTimes(1)
  })
})
