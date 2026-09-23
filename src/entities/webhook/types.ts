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

/**
 * Response shape for the two backend calls that can reveal a secret:
 * saving a brand-new configuration (first PUT /config for an
 * organization) and regenerating one (POST /regenerate-secret). `secret`
 * is present exactly once, in the response of the call that just minted
 * it — never persisted anywhere in this app (no localStorage/
 * sessionStorage, no TanStack Query cache key holds it), and the UI must
 * discard it once the reveal is dismissed. See WebhookConfigModal.tsx.
 */
export interface WebhookConfigWithOptionalSecret {
  config: WebhookConfiguration
  secret?: string
}

export interface WebhookConfigWithSecret {
  config: WebhookConfiguration
  secret: string
}
