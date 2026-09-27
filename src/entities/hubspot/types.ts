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

/**
 * The result of a successful POST /leads/:leadId/sync — mirrors the
 * server's SyncLeadToHubspotResult exactly (server/src/services/
 * hubspot-sync-service.ts). The HubSpot contact id is kept only for
 * internal bookkeeping (e.g. optimistic cache updates) — the UI never
 * displays it, per product decision.
 */
export interface HubspotSyncResult {
  hubspotContactId: string
  syncedAt: string
}

/**
 * The persisted sync status for one lead — mirrors the server's
 * HubspotContactLinkPublic exactly (server/src/repositories/
 * hubspot-repository.ts::toPublicContactLink()). `null` (not this type)
 * represents "never synced" — see fetchHubspotContactLink() in
 * api-client.ts.
 */
export interface HubspotContactLink {
  hubspotContactId: string
  lastSyncedAt: string
  lastSyncStatus: 'synced' | 'failed'
  lastSyncError: string | null
}
