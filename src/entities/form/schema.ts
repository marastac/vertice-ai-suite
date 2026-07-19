import { z } from 'zod'

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
export const QUESTION_TYPES = questionTypeSchema.options

export const CHOICE_QUESTION_TYPES: QuestionType[] = ['single_choice', 'multiple_choice', 'yes_no']

export const formStatusSchema = z.enum(['draft', 'active'])
export type FormStatus = z.infer<typeof formStatusSchema>
export const FORM_STATUSES = formStatusSchema.options

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value)

export const questionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1, 'La opción no puede estar vacía.').max(160, 'La opción es demasiado larga.'),
  points: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: 'Introduce un número de puntos.' })
      .min(0, 'Los puntos no pueden ser negativos.')
      .max(100, 'Máximo 100 puntos.'),
  ),
})
export type QuestionOptionValues = z.output<typeof questionOptionSchema>

export const formQuestionSchema = z
  .object({
    id: z.string().min(1),
    type: questionTypeSchema,
    label: z
      .string()
      .trim()
      .min(3, 'La pregunta debe tener al menos 3 caracteres.')
      .max(200, 'La pregunta es demasiado larga.'),
    required: z.boolean(),
    points: z.preprocess(
      emptyToUndefined,
      z.coerce
        .number({ error: 'Introduce un número de puntos.' })
        .min(0, 'Los puntos no pueden ser negativos.')
        .max(100, 'Máximo 100 puntos.')
        .optional(),
    ),
    options: z.array(questionOptionSchema).optional(),
  })
  .superRefine((question, ctx) => {
    if (CHOICE_QUESTION_TYPES.includes(question.type) && (!question.options || question.options.length < 2)) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Añade al menos dos opciones.' })
    }
  })

export const formBuilderSchema = z
  .object({
    name: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres.').max(120, 'El nombre es demasiado largo.'),
    description: z.preprocess(emptyToUndefined, z.string().trim().max(500, 'La descripción es demasiado larga.').optional()),
    status: formStatusSchema,
    questions: z.array(formQuestionSchema).min(1, 'Añade al menos una pregunta.'),
  })
  .superRefine((form, ctx) => {
    if (!form.questions.some((question) => question.type === 'email')) {
      ctx.addIssue({
        code: 'custom',
        path: ['questions'],
        message: 'Añade al menos una pregunta de tipo "Correo electrónico" para poder identificar a los leads.',
      })
    }
  })

export type FormBuilderValues = z.output<typeof formBuilderSchema>
export type FormBuilderInput = z.input<typeof formBuilderSchema>
