import { AppError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { config } from '../config.js'
import { decryptHubspotToken, encryptHubspotToken } from '../lib/hubspot-crypto.js'
import { hubspotRepository } from '../repositories/hubspot-repository.js'
import type { HubspotConnectionRow, LeadForSyncRow } from '../repositories/hubspot-repository.js'
import { isDefinitiveAuthRejection, refreshAccessToken } from './hubspot-oauth.js'
import type { RefreshedTokens } from './hubspot-oauth.js'
import { updateHubspotContactById, upsertHubspotContact } from './hubspot-contacts.js'
import type { HubspotContactProperties, UpdateContactByIdOutcome } from './hubspot-contacts.js'

/**
 * Orchestrates the manual "Enviar a HubSpot"/"Actualizar en HubSpot" sync
 * for one lead: connection lookup -> needs_reauth check -> load the lead
 * server-side -> access-token freshness (refresh if needed) -> sync the
 * contact -> record the outcome in hubspot_contact_links. Extracted from
 * the route handler so it's directly testable without an HTTP harness,
 * same pattern as routes/hubspot.ts::handleOauthCallback()/
 * disconnectHubspotConnection().
 *
 * First sync vs. resync — this is the fix for a real, confirmed defect:
 * upserting by email on EVERY sync meant that changing a lead's email and
 * re-syncing could silently create a second HubSpot contact (the old one,
 * still under the old email, orphaned) or — worse — attach to a
 * completely unrelated existing contact that happens to share the new
 * email. The strategy now depends on whether `hubspot_contact_links`
 * already has a row for this lead:
 *   - NO existing link (first-ever sync): upsertHubspotContact() (by
 *     email) — unchanged from before. Correct here: there is no known
 *     contact id yet, so identifying/creating by email is exactly what a
 *     first sync should do.
 *   - EXISTING link: updateHubspotContactById() — identifies the contact
 *     by the id we already know, NEVER by email again, so a changed email
 *     updates the SAME contact instead of finding/creating a different
 *     one. Three sub-cases, per updateHubspotContactById()'s own doc
 *     comment:
 *     - `updated` -> done, link stays pointed at the same id.
 *     - `not_found` (the known contact was deleted in HubSpot) -> falls
 *       through to the same upsertHubspotContact() (by email) path as a
 *       first sync, and the link is updated to whatever id comes back.
 *     - `conflict` (the new email collides with a different existing
 *       contact) -> never falls back, never changes the stored id, a
 *       specific sanitized error is recorded and thrown instead.
 *     - any OTHER failure (timeout, network error, an unrecognized
 *       status/category) -> never falls back either; the existing link is
 *       preserved exactly as it was, a generic sanitized error is
 *       recorded and thrown.
 */

// Refresh proactively once the stored access token is within this window of
// expiring, not only once it has already expired outright — avoids a sync
// attempt racing a token that dies mid-request.
const REFRESH_BUFFER_MS = 2 * 60_000

// Deliberately simple — this is a defensive check against an obviously
// malformed value before spending a call to HubSpot, not a full RFC 5322
// validator. `leads.email` is already `not null` and every lead-creation
// path in the frontend already requires a real email; this exists for the
// rare/legacy row that might not satisfy that.
const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface SyncLeadToHubspotParams {
  organizationId: string
  leadId: string
}

export interface SyncLeadToHubspotResult {
  hubspotContactId: string
  syncedAt: string
}

/**
 * Splits Lead AI's single `name` field into HubSpot's separate
 * firstname/lastname properties — the Lead model has no dedicated
 * first/last name fields (see entities/lead/types.ts), so this is the only
 * available derivation. Everything up to the first space is `firstname`;
 * the remainder (trimmed) is `lastname`, omitted entirely when the name has
 * no space at all (a single-word name is sent as firstname only, never a
 * fabricated empty lastname).
 */
export function splitLeadName(name: string): { firstname: string; lastname?: string } {
  const trimmed = name.trim()
  const firstSpaceIndex = trimmed.indexOf(' ')
  if (firstSpaceIndex === -1) return { firstname: trimmed }

  const lastname = trimmed.slice(firstSpaceIndex + 1).trim()
  return { firstname: trimmed.slice(0, firstSpaceIndex), lastname: lastname.length > 0 ? lastname : undefined }
}

/**
 * Maps ONLY fields that actually exist on Lead AI's `Lead` model to
 * HubSpot's standard contact properties: `email` (required, also the
 * upsert key), `firstname`/`lastname` (derived from `name`, see
 * splitLeadName()), `phone`, `company`. Nothing else — no invented or
 * placeholder properties.
 */
export function mapLeadToHubspotProperties(lead: LeadForSyncRow): HubspotContactProperties {
  const { firstname, lastname } = splitLeadName(lead.name)
  return {
    email: lead.email,
    firstname,
    lastname,
    phone: lead.phone ?? undefined,
    company: lead.company,
  }
}

function requireEncryptionKey(): Buffer {
  if (!config.hubspotTokenEncryptionKey) {
    throw new AppError(503, 'La integración con HubSpot no está configurada en el servidor todavía.')
  }
  return config.hubspotTokenEncryptionKey
}

/**
 * Returns a valid, decrypted access token — refreshing first if the stored
 * one has expired or is within REFRESH_BUFFER_MS of expiring. On a
 * successful refresh, persists the new access token and, per HubSpot's own
 * documented behavior (refresh_token rotation is not guaranteed on every
 * call), OVERWRITES the stored refresh token only when HubSpot returned a
 * new one — otherwise the existing encrypted refresh token is kept
 * unchanged, never replaced with null/empty.
 *
 * A refresh that fails outright (refreshAccessToken() throws — invalid or
 * revoked refresh token, or any other error from HubSpot's token endpoint)
 * is treated as definitive: needs_reauth is flipped to true and a clear,
 * retryable-only-by-reconnecting error is thrown. This function never
 * retries a failed refresh itself.
 */
async function ensureFreshAccessToken(organizationId: string, connection: HubspotConnectionRow, key: Buffer): Promise<string> {
  const expiresAtMs = new Date(connection.access_token_expires_at).getTime()
  const isStillFresh = Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > REFRESH_BUFFER_MS
  if (isStillFresh) {
    return decryptHubspotToken(connection.access_token_encrypted, key)
  }

  let refreshToken: string
  try {
    refreshToken = decryptHubspotToken(connection.refresh_token_encrypted, key)
  } catch {
    // Never log the ciphertext or any derived value — see
    // hubspot-crypto.ts's decryptHubspotToken() doc comment.
    logger.error('Could not decrypt HubSpot refresh token before refresh', { organizationId })
    throw new AppError(502, 'No se pudo verificar el token guardado de HubSpot.')
  }

  let refreshed: RefreshedTokens
  try {
    refreshed = await refreshAccessToken(refreshToken)
  } catch (error) {
    if (isDefinitiveAuthRejection(error)) {
      // HubSpot itself returned a non-2xx from the token endpoint for this
      // refresh_token grant — the standard signal that the refresh token is
      // revoked/invalid. This is the ONLY case that flips needs_reauth.
      await hubspotRepository.setNeedsReauth(organizationId, true)
      logger.warn('HubSpot token refresh rejected — marked needs_reauth', { organizationId })
      throw new AppError(409, 'La conexión con HubSpot expiró o fue revocada. Reconéctala para continuar.')
    }

    // A timeout, a network failure, or a malformed/unparseable response
    // says nothing about whether the stored refresh token is still valid —
    // needs_reauth is deliberately left untouched here. The caller can
    // simply retry the sync; nothing about the connection itself changed.
    logger.warn('HubSpot token refresh failed transiently (timeout, network error, or malformed response) — needs_reauth left unchanged', {
      organizationId,
      message: error instanceof Error ? error.message : String(error),
    })
    throw new AppError(502, 'No se pudo renovar la conexión con HubSpot. Inténtalo de nuevo en unos segundos.')
  }

  const refreshTokenEncrypted = refreshed.refreshToken
    ? encryptHubspotToken(refreshed.refreshToken, key)
    : connection.refresh_token_encrypted // HubSpot didn't rotate it this time — keep the previous one, never null.

  await hubspotRepository.updateTokensAfterRefresh(organizationId, {
    accessTokenEncrypted: encryptHubspotToken(refreshed.accessToken, key),
    refreshTokenEncrypted,
    accessTokenExpiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString(),
  })

  return refreshed.accessToken
}

/**
 * Records a failed sync attempt in hubspot_contact_links — but only when a
 * link row already exists (a lead that has synced successfully before).
 * `hubspot_contact_id` is `not null` in the schema (see
 * migrations-hubspot.sql), so a lead that has NEVER synced successfully has
 * no sensible contact id to persist alongside a 'failed' status; for that
 * case this deliberately writes nothing; the failure is still surfaced to
 * the caller via the thrown/returned error either way; it's just not
 * persisted as a link row.
 */
async function recordSyncFailure(organizationId: string, leadId: string, sanitizedError: string): Promise<void> {
  const existing = await hubspotRepository.getContactLink(organizationId, leadId)
  if (!existing) return

  await hubspotRepository.upsertContactLink({
    organizationId,
    leadId,
    hubspotContactId: existing.hubspot_contact_id,
    status: 'failed',
    error: sanitizedError,
  })
}

/**
 * Entry point called by POST /api/hubspot/leads/:leadId/sync. Every error
 * path throws an AppError with a Spanish, user-safe message — never a raw
 * HubSpot/Supabase error, and never one that includes the lead's email,
 * phone, or any token material.
 */
export async function syncLeadToHubspot(params: SyncLeadToHubspotParams): Promise<SyncLeadToHubspotResult> {
  const { organizationId, leadId } = params
  const key = requireEncryptionKey()

  const connection = await hubspotRepository.getConnection(organizationId)
  if (!connection) {
    throw new AppError(404, 'No hay ninguna conexión con HubSpot configurada todavía.')
  }
  if (connection.needs_reauth) {
    throw new AppError(409, 'La conexión con HubSpot necesita reautorización. Reconéctala para continuar.')
  }

  const lead = await hubspotRepository.getLeadForSync(organizationId, leadId)
  if (!lead) {
    // Covers both "no lead with this id" and "this lead belongs to a
    // different organization" identically — see getLeadForSync()'s doc
    // comment. Never distinguished to the caller.
    throw new AppError(404, 'Lead no encontrado.')
  }

  if (!SIMPLE_EMAIL_PATTERN.test(lead.email)) {
    throw new AppError(400, 'Este lead no tiene un correo electrónico válido para sincronizar con HubSpot.')
  }

  // Decided BEFORE touching the token/HubSpot at all — this is what
  // chooses first-sync-by-email vs. resync-by-id below.
  const existingLink = await hubspotRepository.getContactLink(organizationId, leadId)

  let accessToken: string
  try {
    accessToken = await ensureFreshAccessToken(organizationId, connection, key)
  } catch (error) {
    // ensureFreshAccessToken() already throws AppError for every case it
    // handles (decrypt failure, refresh failure) — this catch exists only
    // to record the failure against any existing link row before
    // re-throwing, never to swallow or reclassify the error.
    const message = error instanceof AppError ? error.publicMessage : 'No se pudo preparar la conexión con HubSpot.'
    await recordSyncFailure(organizationId, leadId, message)
    throw error
  }

  const properties = mapLeadToHubspotProperties(lead)

  if (existingLink) {
    let updateResult: UpdateContactByIdOutcome
    try {
      updateResult = await updateHubspotContactById(accessToken, existingLink.hubspot_contact_id, properties)
    } catch (error) {
      // Timeout, network error, or an unrecognized HubSpot response — NEVER
      // falls back to upsert-by-email (that could create a duplicate or
      // attach to an unrelated contact); the existing link is left exactly
      // as it was, only its status/error are updated.
      const message = error instanceof AppError ? error.publicMessage : 'No se pudo sincronizar el lead con HubSpot.'
      await recordSyncFailure(organizationId, leadId, message)
      throw error instanceof AppError ? error : new AppError(502, message)
    }

    if (updateResult.outcome === 'conflict') {
      // A different existing HubSpot contact already has this email —
      // never guess, never fall back, never touch the stored contact id.
      await recordSyncFailure(organizationId, leadId, updateResult.message)
      throw new AppError(409, updateResult.message)
    }

    if (updateResult.outcome === 'updated') {
      await hubspotRepository.upsertContactLink({
        organizationId,
        leadId,
        hubspotContactId: updateResult.hubspotContactId,
        status: 'synced',
        error: null,
      })
      return { hubspotContactId: updateResult.hubspotContactId, syncedAt: new Date().toISOString() }
    }

    // outcome === 'not_found' — the known contact was deleted in HubSpot.
    // Falls through to the same upsert-by-email path a first-ever sync
    // takes, below.
  }

  try {
    const { hubspotContactId } = await upsertHubspotContact(accessToken, properties)
    await hubspotRepository.upsertContactLink({
      organizationId,
      leadId,
      hubspotContactId,
      status: 'synced',
      error: null,
    })
    return { hubspotContactId, syncedAt: new Date().toISOString() }
  } catch (error) {
    const message = error instanceof AppError ? error.publicMessage : 'No se pudo sincronizar el lead con HubSpot.'
    await recordSyncFailure(organizationId, leadId, message)
    throw error instanceof AppError ? error : new AppError(502, message)
  }
}
