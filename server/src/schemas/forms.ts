import { z } from 'zod'

/**
 * Mirrors the question-type union already established for the admin form
 * builder (src/entities/form/schema.ts) — kept as an INDEPENDENT copy, same
 * reasoning as chat-config-repository.ts's own row mapper: this backend
 * package has its own node_modules/build and must never import frontend
 * source (see CLAUDE.md's "Backend (server/)" section).
 */
export const questionTypeSchema = z.enum([
  'short_text',
  'long_text',
  'email',
  'phone',
  'number',
  'single_choice',
  'multiple_choice',
  'yes_no',
])
export type QuestionType = z.infer<typeof questionTypeSchema>

export const CHOICE_QUESTION_TYPES: QuestionType[] = ['single_choice', 'multiple_choice', 'yes_no']

export interface QuestionOption {
  id: string
  label: string
  points: number
}

export interface FormQuestion {
  id: string
  type: QuestionType
  label: string
  required: boolean
  points?: number
  options?: QuestionOption[]
}

/**
 * The ONLY two things a public submission request is allowed to carry.
 * `.strict()` (not the default strip-unknown-keys behavior) means a request
 * body containing ANY extra field — `organizationId`, `score`, `status`,
 * `source`, `leadId`, `submissionId`, `chat_session_id`, or anything else —
 * is REJECTED outright (400) rather than silently ignored. This is the
 * Fase C hardening's first line of defense: the client is structurally
 * incapable of sending an authority value for anything this endpoint
 * decides — see server/src/services/form-submission-service.ts for where
 * organization_id/score/status are actually derived, always server-side.
 */
export const formSubmissionAnswerSchema = z
  .object({
    questionId: z.string().trim().min(1).max(100),
    value: z.union([
      z.string().trim().max(2000, 'La respuesta es demasiado larga.'),
      z.array(z.string().trim().max(200, 'La opción es demasiado larga.')).max(50, 'Demasiadas opciones seleccionadas.'),
    ]),
  })
  .strict()
export type FormSubmissionAnswerInput = z.infer<typeof formSubmissionAnswerSchema>

export const submitPublicFormBodySchema = z
  .object({
    answers: z.array(formSubmissionAnswerSchema).max(100, 'Demasiadas respuestas.'),
    // Honeypot: a hidden field no real visitor ever sees or fills — see
    // src/features/public-form/PublicFormPage.tsx. Any non-empty value here
    // means an automated submission (see form-submission-service.ts, which
    // silently accepts-but-discards rather than erroring, so the bot never
    // learns it was caught). Optional because a legitimate browser always
    // sends it empty, never omits the field, but the schema shouldn't
    // reject a request that omits it either.
    website: z.string().max(500).optional(),
  })
  .strict()
export type SubmitPublicFormBody = z.infer<typeof submitPublicFormBodySchema>
