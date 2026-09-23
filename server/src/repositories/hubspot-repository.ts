import { AppError } from '../lib/errors.js'
import { supabaseAdmin } from '../lib/supabase-client.js'

/**
 * Safe to return to the browser — never includes access_token_encrypted,
 * refresh_token_encrypted, or anything derived from decrypting them. This
 * is the ONLY shape a route handler may ever send in a JSON response for a
 * connection; see toPublicConnection() below, the single function allowed
 * to build it.
 */
export interface HubspotConnectionPublic {
  id: string
  organizationId: string
  hubPortalId: string
  needsReauth: boolean
  connectedAt: string
  updatedAt: string
}

/**
 * Internal-only shape — includes both encrypted token columns. Never
 * return this directly from a route handler; always go through
 * toPublicConnection() first for the parts that are safe to expose. Only
 * the future OAuth/refresh/sync service layers (not yet implemented in
 * this phase) ever decrypt these, and only in-memory, never logged.
 */
export interface HubspotConnectionRow {
  id: string
  organization_id: string
  hub_portal_id: string
  access_token_encrypted: string
  refresh_token_encrypted: string
  access_token_expires_at: string
  scopes: string
  needs_reauth: boolean
  connected_by: string | null
  created_at: string
  updated_at: string
}

export interface HubspotContactLinkRow {
  id: string
  organization_id: string
  lead_id: string
  hubspot_contact_id: string
  last_synced_at: string
  last_sync_status: 'synced' | 'failed'
  last_sync_error: string | null
  created_at: string
}

// The one function allowed to turn a full connection row (with both
// encrypted token columns) into something safe to send to the browser —
// same role as webhook-repository.ts's toPublicConfig(), kept as its own
// independent implementation here rather than imported from that file, so
// this feature has zero code dependency on the Webhooks feature (see the
// HubSpot integration audit's note on what should and shouldn't be reused
// from Webhooks).
export function toPublicConnection(row: HubspotConnectionRow): HubspotConnectionPublic {
  return {
    id: row.id,
    organizationId: row.organization_id,
    hubPortalId: row.hub_portal_id,
    needsReauth: row.needs_reauth,
    connectedAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function client() {
  if (!supabaseAdmin) {
    throw new AppError(503, 'La función de HubSpot no está configurada en el servidor todavía.')
  }
  return supabaseAdmin
}

export const hubspotRepository = {
  /**
   * Internal-only — includes both encrypted token columns. Used only by
   * the (not yet implemented) OAuth/refresh/sync service layers, never
   * returned to a route handler's JSON response directly.
   */
  async getConnection(organizationId: string): Promise<HubspotConnectionRow | null> {
    const { data, error } = await client()
      .from('hubspot_connections')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) throw new AppError(500, 'No se pudo leer la conexión de HubSpot.', error.message)
    return (data as HubspotConnectionRow) ?? null
  },

  /** Safe to return to the browser — never includes the encrypted tokens. */
  async getPublicConnection(organizationId: string): Promise<HubspotConnectionPublic | null> {
    const { data, error } = await client()
      .from('hubspot_connections')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) throw new AppError(500, 'No se pudo leer la conexión de HubSpot.', error.message)
    return data ? toPublicConnection(data as HubspotConnectionRow) : null
  },

  /**
   * Insert-or-replace, keyed on organization_id (which is UNIQUE) —
   * covers both "connect for the first time" and "reconnect after a
   * previous disconnect" with one call. Callers (a later phase's OAuth
   * callback) must have every field ready before calling this — see
   * hub_portal_id's NOT NULL doc comment in migrations-hubspot.sql for why
   * there is deliberately no partial/two-step write here.
   */
  async upsertConnection(params: {
    organizationId: string
    hubPortalId: string
    accessTokenEncrypted: string
    refreshTokenEncrypted: string
    accessTokenExpiresAt: string
    scopes: string
    connectedBy: string
  }): Promise<HubspotConnectionRow> {
    const { data, error } = await client()
      .from('hubspot_connections')
      .upsert(
        {
          organization_id: params.organizationId,
          hub_portal_id: params.hubPortalId,
          access_token_encrypted: params.accessTokenEncrypted,
          refresh_token_encrypted: params.refreshTokenEncrypted,
          access_token_expires_at: params.accessTokenExpiresAt,
          scopes: params.scopes,
          needs_reauth: false,
          connected_by: params.connectedBy,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id' },
      )
      .select('*')
      .single()
    if (error) throw new AppError(500, 'No se pudo guardar la conexión de HubSpot.', error.message)
    return data as HubspotConnectionRow
  },

  /**
   * Flips needs_reauth — `true` when a refresh attempt definitively fails
   * (revoked/invalid refresh token), `false` again on a successful
   * reconnect. Never touches the token columns.
   */
  async setNeedsReauth(organizationId: string, needsReauth: boolean): Promise<void> {
    const { error } = await client()
      .from('hubspot_connections')
      .update({ needs_reauth: needsReauth, updated_at: new Date().toISOString() })
      .eq('organization_id', organizationId)
    if (error) throw new AppError(500, 'No se pudo actualizar el estado de la conexión de HubSpot.', error.message)
  },

  /** Disconnect — removes the row entirely (no "inactive but present" state; see migrations-hubspot.sql's note on why this differs from webhook_configurations, which has no such delete path). */
  async deleteConnection(organizationId: string): Promise<void> {
    const { error } = await client().from('hubspot_connections').delete().eq('organization_id', organizationId)
    if (error) throw new AppError(500, 'No se pudo eliminar la conexión de HubSpot.', error.message)
  },

  async getContactLink(organizationId: string, leadId: string): Promise<HubspotContactLinkRow | null> {
    const { data, error } = await client()
      .from('hubspot_contact_links')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('lead_id', leadId)
      .maybeSingle()
    if (error) throw new AppError(500, 'No se pudo leer el estado de sincronización con HubSpot.', error.message)
    return (data as HubspotContactLinkRow) ?? null
  },

  /** Insert-or-replace, keyed on (organization_id, lead_id) — one row always represents the current sync state for that lead, never a history of attempts. */
  async upsertContactLink(params: {
    organizationId: string
    leadId: string
    hubspotContactId: string
    status: 'synced' | 'failed'
    error?: string | null
  }): Promise<HubspotContactLinkRow> {
    const { data, error } = await client()
      .from('hubspot_contact_links')
      .upsert(
        {
          organization_id: params.organizationId,
          lead_id: params.leadId,
          hubspot_contact_id: params.hubspotContactId,
          last_synced_at: new Date().toISOString(),
          last_sync_status: params.status,
          last_sync_error: params.error ?? null,
        },
        { onConflict: 'organization_id,lead_id' },
      )
      .select('*')
      .single()
    if (error) throw new AppError(500, 'No se pudo guardar el estado de sincronización con HubSpot.', error.message)
    return data as HubspotContactLinkRow
  },
}
