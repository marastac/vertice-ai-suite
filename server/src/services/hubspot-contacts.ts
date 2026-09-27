import { AppError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

/**
 * Minimal client for HubSpot's Contacts API — used only for the manual
 * "Enviar a HubSpot" sync (see hubspot-sync-service.ts, the only caller).
 * Deliberately a single function: this MVP syncs exactly one lead at a
 * time, never a bulk operation.
 *
 * Uses HubSpot's batch upsert-by-email endpoint rather than a
 * search-then-create-or-update sequence: `POST
 * /crm/v3/objects/contacts/batch/upsert` with `idProperty: 'email'` lets
 * HubSpot itself resolve "does a contact with this email already exist" —
 * atomically, server-side, in one call. Two rapid sync attempts for the
 * same lead (a double-click, a retry) can never race into two contacts the
 * way a separate search-then-create would.
 *
 * Deliberately uses the global `fetch()`, same as hubspot-oauth.ts and for
 * the same reason: the destination is a fixed, hardcoded HubSpot domain,
 * never customer/organization-supplied input, so there is no SSRF surface
 * to defend against here.
 */

const CONTACTS_BATCH_UPSERT_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert'

// Same 8s convention as hubspot-oauth.ts's REVOKE_TIMEOUT_MS/POSTFORM_TIMEOUT_MS
// — this is a foreground, interactive action (a user clicking "Enviar a
// HubSpot" on one lead), never a background job. Long enough for a normal
// HubSpot API response, short enough that a hung HubSpot request can't
// leave the sync endpoint (and the button that called it) waiting forever.
const CONTACT_UPSERT_TIMEOUT_MS = 8_000

// HubSpot's documented `status` value for CRM v3 Batch API responses
// (BatchResponse/BatchResponseWithErrors — the schema shared by every
// crm/v3/objects/{type}/batch/* endpoint, upsert included) that means the
// batch has actually finished processing. The same schema documents other
// values (e.g. PENDING/PROCESSING/CANCELED) for a batch that hasn't
// produced a trustworthy final result yet — rather than enumerating and
// guessing every one of those, this only asserts the ONE value that means
// success; anything else (any of those, an unrecognized future value, or a
// missing field) is correctly rejected below without needing to name it.
const COMPLETED_BATCH_STATUS = 'COMPLETE'

/**
 * Only the properties this integration ever sends — see
 * hubspot-sync-service.ts::mapLeadToHubspotProperties() for where these are
 * derived from Lead AI's actual `Lead` fields. `email` is required (it's
 * also the upsert key); every other property is optional and, when absent,
 * is simply omitted from the request body rather than sent as an empty
 * string.
 */
export interface HubspotContactProperties {
  email: string
  firstname?: string
  lastname?: string
  phone?: string
  company?: string
}

export interface UpsertedHubspotContact {
  hubspotContactId: string
}

function buildPropertiesBody(properties: HubspotContactProperties): Record<string, string> {
  const body: Record<string, string> = { email: properties.email }
  if (properties.firstname) body.firstname = properties.firstname
  if (properties.lastname) body.lastname = properties.lastname
  if (properties.phone) body.phone = properties.phone
  if (properties.company) body.company = properties.company
  return body
}

/**
 * Structural validation — a 2xx/207 HTTP status alone is NEVER enough to
 * consider the sync successful; this is what actually decides that. The
 * full response body is never logged (it can echo back the very
 * email/phone/company we sent — see the doc comment on
 * upsertHubspotContact() below); only `status` and, for a partial-errors
 * response, the first error's `category` (a short HubSpot-defined enum
 * label, never free-text) are ever passed to the logger.
 *
 * Expected shape (HubSpot's BatchResponse/BatchResponseWithErrors schema):
 * `{ status: 'COMPLETE', results: [{ id: '<contact id>', ... }], errors?: [...] }`.
 * Every one of the following must hold, in order, or this throws instead of
 * returning:
 *   1. `status` must be present and equal to 'COMPLETE' — any other value
 *      (HubSpot's documented alternatives for this schema, or anything
 *      unrecognized) means the batch hasn't produced a trustworthy final
 *      result and is never treated as a success.
 *   2. `errors` must be absent or empty. A 207 for this endpoint can carry
 *      `status: 'COMPLETE'` at the batch level while still reporting the
 *      one input we sent as failed — since this integration always sends
 *      exactly one input, ANY reported error means OUR input is the one
 *      that failed, even if `results` also contains something (that
 *      combination would be self-contradictory data, never trusted).
 *   3. `results` must be a non-empty array.
 *   4. `results[0].id` must be a non-empty string — the actual
 *      hubspotContactId returned to the caller.
 */
function parseUpsertResponse(json: unknown): UpsertedHubspotContact {
  if (!json || typeof json !== 'object') {
    throw new AppError(502, 'HubSpot devolvió una respuesta con un formato inesperado.')
  }
  const body = json as Record<string, unknown>

  const status = body.status
  if (typeof status !== 'string' || status.length === 0) {
    throw new AppError(502, 'HubSpot devolvió una respuesta sin un estado de sincronización reconocible.')
  }
  if (status !== COMPLETED_BATCH_STATUS) {
    logger.error('HubSpot contact upsert did not complete', { status })
    throw new AppError(502, 'HubSpot todavía no completó la sincronización del contacto. Inténtalo de nuevo.')
  }

  const errors = body.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const firstError = errors[0]
    const errorCategory =
      firstError && typeof firstError === 'object' && typeof (firstError as Record<string, unknown>).category === 'string'
        ? (firstError as Record<string, unknown>).category
        : undefined
    logger.error('HubSpot contact upsert reported partial errors', { status, errorCategory })
    throw new AppError(502, 'HubSpot no pudo sincronizar el contacto (respuesta con errores).')
  }

  const results = body.results
  if (!Array.isArray(results) || results.length === 0) {
    throw new AppError(502, 'HubSpot no devolvió ningún resultado de sincronización.')
  }

  const first = results[0]
  const id = first && typeof first === 'object' ? (first as Record<string, unknown>).id : undefined
  if (typeof id !== 'string' || id.length === 0) {
    throw new AppError(502, 'HubSpot no devolvió un identificador de contacto válido.')
  }

  return { hubspotContactId: id }
}

/**
 * Upserts exactly one contact by email. Never logs `accessToken`,
 * `properties` (contains the lead's email/phone/company — PII), the raw
 * request body, or the raw response body — only a sanitized action label,
 * HTTP status, and (via parseUpsertResponse()) a batch `status`/error
 * category, same convention as hubspot-oauth.ts's postForm(). A response
 * body could echo the very properties we sent, so even error logging here
 * stays limited to non-sensitive metadata.
 *
 * Bounded to CONTACT_UPSERT_TIMEOUT_MS via AbortController, same pattern as
 * hubspot-oauth.ts's postForm()/revokeRefreshToken() — a hung HubSpot
 * response can no longer leave this call (and the "Enviar a HubSpot" button
 * that triggered it) waiting indefinitely. The timer is always cleared in
 * `finally`. A timeout here never implies anything about the connection's
 * access token being invalid — it only ever surfaces as a plain, retryable
 * AppError; needs_reauth is a concern of the token-refresh path
 * (hubspot-sync-service.ts::ensureFreshAccessToken()), never of this
 * function, which doesn't even have access to the connection record.
 */
export async function upsertHubspotContact(accessToken: string, properties: HubspotContactProperties): Promise<UpsertedHubspotContact> {
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), CONTACT_UPSERT_TIMEOUT_MS)
  let response: Response
  try {
    try {
      response = await fetch(CONTACTS_BATCH_UPSERT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: [
            {
              id: properties.email,
              idProperty: 'email',
              properties: buildPropertiesBody(properties),
            },
          ],
        }),
        signal: controller.signal,
      })
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'AbortError'
      logger.error(isTimeout ? 'HubSpot contact upsert request timed out' : 'HubSpot contact upsert request failed')
      throw new AppError(
        isTimeout ? 504 : 502,
        isTimeout
          ? 'Se agotó el tiempo de espera al sincronizar con HubSpot. Inténtalo de nuevo.'
          : 'No se pudo contactar a HubSpot. Inténtalo de nuevo.',
      )
    }
  } finally {
    clearTimeout(timeoutHandle)
  }

  if (!response.ok) {
    logger.error('HubSpot contact upsert returned an error status', { status: response.status })
    throw new AppError(502, 'HubSpot rechazó la sincronización del contacto. Inténtalo de nuevo.')
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new AppError(502, 'HubSpot devolvió una respuesta inesperada.')
  }

  return parseUpsertResponse(json)
}
