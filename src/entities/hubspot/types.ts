/**
 * Never carries access_token/refresh_token — the browser is never handed
 * them. Mirrors server/src/repositories/hubspot-repository.ts's
 * HubspotConnectionPublic exactly; see that file and
 * server/src/routes/hubspot.ts's GET /connection for where that boundary
 * actually lives.
 */
export interface HubspotConnection {
  id: string
  organizationId: string
  hubPortalId: string
  /** true when a token refresh has definitively failed (revoked/invalid refresh token) — the connection row is kept so the UI can offer "Reconectar" instead of silently showing "No conectado" with no explanation. */
  needsReauth: boolean
  connectedAt: string
  updatedAt: string
}
