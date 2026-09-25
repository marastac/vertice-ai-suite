import { z } from 'zod'

export const hubspotOrganizationQuerySchema = z.object({
  organizationId: z.uuid(),
})
export type HubspotOrganizationQuery = z.infer<typeof hubspotOrganizationQuerySchema>

export const hubspotDisconnectBodySchema = z.object({
  organizationId: z.uuid(),
})
export type HubspotDisconnectBody = z.infer<typeof hubspotDisconnectBodySchema>
