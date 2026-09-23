import { z } from 'zod'

export const webhookOrganizationQuerySchema = z.object({
  organizationId: z.uuid(),
})
export type WebhookOrganizationQuery = z.infer<typeof webhookOrganizationQuerySchema>

export const webhookConfigBodySchema = z.object({
  organizationId: z.uuid(),
  url: z.string().trim().min(1, 'La URL es obligatoria.').max(2048, 'La URL es demasiado larga.'),
  isActive: z.boolean(),
})
export type WebhookConfigBody = z.infer<typeof webhookConfigBodySchema>

export const webhookTestBodySchema = z.object({
  organizationId: z.uuid(),
})
export type WebhookTestBody = z.infer<typeof webhookTestBodySchema>

// Same shape as webhookTestBodySchema — kept as its own named schema (not a
// shared alias) so each endpoint's request contract reads as its own thing,
// matching this file's existing one-schema-per-route convention.
export const webhookRegenerateSecretBodySchema = z.object({
  organizationId: z.uuid(),
})
export type WebhookRegenerateSecretBody = z.infer<typeof webhookRegenerateSecretBodySchema>
