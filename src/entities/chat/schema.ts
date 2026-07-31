import { z } from 'zod'

export const chatToneSchema = z.enum(['professional', 'friendly', 'concise', 'consultative'])
export const CHAT_TONES = chatToneSchema.options

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value)

export const qualificationCriterionFormSchema = z.object({
  id: z.string().min(1),
  label: z
    .string()
    .trim()
    .min(2, 'El criterio debe tener al menos 2 caracteres.')
    .max(160, 'El criterio es demasiado largo.'),
  points: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: 'Introduce un número de puntos.' })
      .min(0, 'Los puntos no pueden ser negativos.')
      .max(100, 'Máximo 100 puntos.'),
  ),
})

export const collectedQuestionFormSchema = z.object({
  id: z.string().min(1),
  value: z.string().trim().min(1, 'Este campo no puede estar vacío.').max(200, 'El texto es demasiado largo.'),
})

export const chatSettingsSchema = z.object({
  assistantName: z
    .string()
    .trim()
    .min(2, 'Introduce un nombre para el asistente.')
    .max(80, 'El nombre es demasiado largo.'),
  welcomeMessage: z
    .string()
    .trim()
    .min(2, 'Introduce un mensaje de bienvenida.')
    .max(500, 'El mensaje es demasiado largo.'),
  agencyDescription: z.string().trim().max(1000, 'La descripción es demasiado larga.'),
  servicesOffered: z.string().trim().max(1000, 'El texto es demasiado largo.'),
  tone: chatToneSchema,
  language: z.string().trim().min(2, 'Indica el idioma.').max(40, 'El idioma es demasiado largo.'),
  questionsToCollect: z.array(collectedQuestionFormSchema).max(20, 'Máximo 20 elementos.'),
  criteria: z.array(qualificationCriterionFormSchema).max(20, 'Máximo 20 criterios.'),
  minQualifiedScore: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: 'Introduce una puntuación mínima.' })
      .min(0, 'La puntuación mínima es 0.')
      .max(100, 'La puntuación máxima es 100.'),
  ),
  additionalInstructions: z.preprocess(
    emptyToUndefined,
    z.string().trim().max(1000, 'El texto es demasiado largo.').optional(),
  ),
  isActive: z.boolean(),
})

export type ChatSettingsInput = z.input<typeof chatSettingsSchema>
export type ChatSettingsValues = z.output<typeof chatSettingsSchema>
