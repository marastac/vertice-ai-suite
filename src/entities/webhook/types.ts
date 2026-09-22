/**
 * Never carries `secret` — the browser is never handed it. See
 * entities/webhook/api-client.ts and server/src/repositories/webhook-repository.ts's
 * toPublicConfig() for where that boundary actually lives.
 */
export interface WebhookConfiguration {
  id: string
  organizationId: string
  url: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookTestResult {
  success: boolean
  responseStatus: number | null
  errorReason: string | null
}
