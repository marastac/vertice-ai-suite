import { z } from 'zod'

export const chatToneSchema = z.enum(['professional', 'friendly', 'concise', 'consultative'])
export type ChatTone = z.infer<typeof chatToneSchema>

export const qualificationCriterionSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(2, 'El criterio es demasiado corto.').max(160, 'El criterio es demasiado largo.'),
  points: z.number({ error: 'Introduce un número de puntos.' }).min(0).max(100),
})
export type QualificationCriterionInput = z.infer<typeof qualificationCriterionSchema>

export const chatConfigurationSchema = z.object({
  assistantName: z.string().trim().min(2, 'El nombre es demasiado corto.').max(80, 'El nombre es demasiado largo.'),
  welcomeMessage: z.string().trim().min(2, 'El mensaje de bienvenida es demasiado corto.').max(500),
  agencyDescription: z.string().trim().max(1000).default(''),
  servicesOffered: z.string().trim().max(1000).default(''),
  tone: chatToneSchema,
  language: z.string().trim().min(2).max(40).default('Español'),
  questionsToCollect: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  criteria: z.array(qualificationCriterionSchema).max(20).default([]),
  minQualifiedScore: z.number().min(0).max(100).default(70),
  additionalInstructions: z.string().trim().max(1000).optional(),
  isActive: z.boolean().default(true),
})
export type ChatConfigurationInput = z.infer<typeof chatConfigurationSchema>

export const createSessionBodySchema = z.object({
  orgSlug: z.string().trim().min(1).max(100),
  config: chatConfigurationSchema,
})
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>

// Excessively long messages are rejected before ever reaching the model.
export const postMessageBodySchema = z.object({
  message: z.string().trim().min(1, 'Escribe un mensaje.').max(4000, 'El mensaje es demasiado largo.'),
})
export type PostMessageBody = z.infer<typeof postMessageBodySchema>

export const chatQualificationStatusSchema = z.enum(['disqualified', 'qualifying', 'qualified'])

export const chatQualificationResultSchema = z.object({
  contactName: z.string().trim().min(1).nullable(),
  email: z.string().trim().min(1).nullable(),
  phone: z.string().trim().min(1).nullable(),
  company: z.string().trim().min(1).nullable(),
  businessType: z.string().trim().min(1).nullable(),
  requestedService: z.string().trim().min(1).nullable(),
  budget: z.string().trim().min(1).nullable(),
  timeline: z.string().trim().min(1).nullable(),
  mainNeed: z.string().trim().min(1).nullable(),
  summary: z.string().trim().min(1).max(1000),
  score: z.number().min(0).max(100),
  status: chatQualificationStatusSchema,
  reasons: z.array(z.string().trim().min(1)).max(20),
  collectedFields: z.array(z.string().trim().min(1)).max(20),
  missingFields: z.array(z.string().trim().min(1)).max(20),
  conversationComplete: z.boolean(),
})
export type ChatQualificationResult = z.infer<typeof chatQualificationResultSchema>
