import { z } from 'zod'

export const hubspotOrganizationQuerySchema = z.object({
  organizationId: z.uuid(),
})
export type HubspotOrganizationQuery = z.infer<typeof hubspotOrganizationQuerySchema>

export const hubspotDisconnectBodySchema = z.object({
  organizationId: z.uuid(),
})
export type HubspotDisconnectBody = z.infer<typeof hubspotDisconnectBodySchema>

/** :leadId route param for POST /leads/:leadId/sync. */
export const hubspotSyncLeadParamsSchema = z.object({
  leadId: z.uuid(),
})
export type HubspotSyncLeadParams = z.infer<typeof hubspotSyncLeadParamsSchema>

/**
 * Body for POST /leads/:leadId/sync — deliberately ONLY `organizationId`.
 * The browser identifies which lead and which organization; every actual
 * lead field (name, email, phone, company) is loaded server-side from
 * `leads` via hubspotRepository.getLeadForSync() and is never accepted from
 * the request body, so a compromised/buggy frontend can never make the
 * server send fabricated data to HubSpot under a real lead's identity.
 */
export const hubspotSyncLeadBodySchema = z.object({
  organizationId: z.uuid(),
})
export type HubspotSyncLeadBody = z.infer<typeof hubspotSyncLeadBodySchema>
