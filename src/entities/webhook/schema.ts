import { z } from 'zod'

export const webhookConfigSchema = z.object({
  url: z
    .url('Introduce una URL válida.')
    .refine((value) => value.startsWith('https://'), 'La URL debe empezar con https://.'),
  isActive: z.boolean(),
})
export type WebhookConfigValues = z.infer<typeof webhookConfigSchema>
