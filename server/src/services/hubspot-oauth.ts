import { AppError } from '../lib/errors.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * All calls to HubSpot's own OAuth infrastructure — authorize URL,
 * token exchange/refresh, portal-id lookup, revocation.
 *
 * Endpoint provenance — cited exactly:
 *
 * - Token exchange/refresh and introspection: confirmed live against
 *   developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens
 *   (HubSpot's own CURRENT "latest" API reference) — `POST /oauth/2026-09/token`
 *   and `POST /oauth/2026-09/token/introspect`. An earlier HubSpot
 *   changelog (Jan 27, 2026, "New OAuth v3 API Endpoints") documents the
 *   same two operations under `/oauth/v3/token` / `/oauth/v3/introspect`
 *   instead — that announcement predates and is superseded by the
 *   "latest" reference above, which is what's actually followed here.
 * - Revocation: confirmed live against
 *   developers.hubspot.com/docs/api-reference/latest/authentication/oauth-tokens/revoke-token
 *   — the dedicated, current reference page for this exact operation —
 *   `POST /oauth/2026-09/token/revoke`, with `client_id`, `client_secret`,
 *   `token`, and `token_type_hint` as the documented request body fields.
 *
 * Uses the global `fetch()`, unlike webhook-delivery-service.ts's use of
 * `node:https` with a pinned `lookup`. That pinning exists there because
 * the destination host is customer-supplied (SSRF risk). Every host here
 * is a fixed, hardcoded HubSpot domain — never customer input — so there
 * is no SSRF surface to defend against and no reason to carry that
 * complexity into this file.
 */

// Unversioned — HubSpot's own OAuth consent screen, stable across API
// version changes.
const AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize'
const TOKEN_URL = 'https://api.hubapi.com/oauth/2026-09/token'
const INTROSPECT_URL = 'https://api.hubapi.com/oauth/2026-09/token/introspect'
const REVOKE_URL = 'https://api.hubapi.com/oauth/2026-09/token/revoke'
const REVOKE_TIMEOUT_MS = 8_000
// Same convention as REVOKE_TIMEOUT_MS above — postForm() backs three
// foreground, interactive operations (the OAuth callback's code exchange,
// the sync flow's token refresh, and the portal-id introspection right
// after it), never a background job. 8s is enough for a normal HubSpot
// token-endpoint response without leaving a request hanging indefinitely
// if HubSpot is unresponsive.
const POSTFORM_TIMEOUT_MS = 8_000

// Minimal scope for this MVP — write-only, no .read, no
// crm.schemas.contacts.write (see the HubSpot integration audit for the
// full reasoning). Must stay in sync with
// lead-ai-hubspot/src/app/app-hsmeta.json's requiredScopes — that file is
// the actual scope grant registered with HubSpot; this string is only what
// Lead AI's own authorize-URL request asks for and must not drift from it.
const SCOPES = 'crm.objects.contacts.write'

export interface ExchangedTokens {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
}

export interface RefreshedTokens {
  accessToken: string
  /** `null` when HubSpot's refresh response didn't include a new refresh_token — documentation does not guarantee rotation on every call, so callers must preserve the previous stored value in that case, never assume either behavior. */
  refreshToken: string | null
  expiresInSeconds: number
}

/**
 * `revoked: true` only for a confirmed 2xx from HubSpot's revoke endpoint.
 * Every other case — 404, any other non-2xx status, a network error, or a
 * timeout — resolves to `revoked: false`. A 404 is deliberately NOT
 * special-cased as "already revoked": it could just as easily mean the
 * `/revoke` path itself doesn't exist (a bad deploy, a wrong base URL, an
 * API change on HubSpot's side) as it could mean the token is gone — the
 * revoke-token reference page documents only a generic error schema
 * (category/correlationId/message) with no stated meaning for 404
 * specifically, so there is nothing reliable to key off. The caller must
 * treat `revoked: false` uniformly as "not confirmed — keep the
 * connection, let the admin retry."
 */
export interface RevokeResult {
  revoked: boolean
  reason?: string
}

/**
 * Why postForm()'s failures are tagged rather than left as plain AppError:
 * hubspot-sync-service.ts::ensureFreshAccessToken() must tell "HubSpot
 * definitively rejected the refresh token" (reason: 'rejected' — a non-2xx
 * HTTP status from HubSpot's own token endpoint, the same signal that
 * already meant this before this change) apart from "we simply couldn't
 * get a response in time" (reason: 'timeout'), "the network request itself
 * never completed" (reason: 'network_error'), or "HubSpot answered but the
 * body didn't parse/validate" (reason: 'invalid_response') — only the
 * first of these should ever flip needs_reauth. A timeout or a transient
 * network hiccup says nothing about whether the stored refresh token is
 * still valid, so it must never be treated the same as a real rejection.
 */
export type HubspotOauthFailureReason = 'timeout' | 'network_error' | 'rejected' | 'invalid_response'

export class HubspotOauthError extends AppError {
  reason: HubspotOauthFailureReason

  constructor(status: number, publicMessage: string, reason: HubspotOauthFailureReason) {
    super(status, publicMessage)
    this.reason = reason
  }
}

/**
 * True only for a definitive HTTP-level rejection from HubSpot's own token
 * endpoint — never for a timeout, a network failure, or a malformed
 * response. Deliberately duck-typed on `.reason` rather than `error
 * instanceof HubspotOauthError`: an `instanceof` check against a class
 * imported statically can spuriously fail in tests that re-import this
 * module after `vi.resetModules()` (each re-import creates a distinct
 * class object) — checking a plain property is immune to that and behaves
 * identically in production, where there is only ever one module instance.
 */
export function isDefinitiveAuthRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'rejected'
}

function requireConfigured(): void {
  if (!config.isHubspotConfigured) {
    throw new AppError(503, 'La integración con HubSpot no está configurada en el servidor todavía.')
  }
}

/** Builds the URL the browser is sent to for HubSpot's own consent screen. Only ever includes `client_id` (not itself a secret) — never the client secret. */
export function buildAuthorizeUrl(state: string): string {
  requireConfigured()
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', config.hubspotClientId!)
  url.searchParams.set('redirect_uri', config.hubspotRedirectUri!)
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', state)
  return url.toString()
}

/**
 * Shared POST helper for every token-endpoint call below. Deliberately
 * never logs or rethrows the response body or a raw fetch/Node error —
 * only a sanitized action label and HTTP status, same "never let a raw
 * upstream error leak" convention as webhook-delivery-service.ts. HubSpot's
 * token responses can contain the very secrets this whole feature exists
 * to protect, so the body is only ever parsed and handed to a typed
 * validator, never logged as-is.
 *
 * Bounded to POSTFORM_TIMEOUT_MS via AbortController, same pattern as
 * revokeRefreshToken() below — a hung HubSpot response can no longer leave
 * a caller (the OAuth callback, or the sync flow's token refresh) waiting
 * indefinitely. The timer is always cleared in `finally`, whether the
 * request settles in time, fails, or is aborted, so no timer is ever left
 * running past this call.
 *
 * Every failure is thrown as a reason-tagged HubspotOauthError (see its doc
 * comment above) rather than a plain AppError, so a caller like
 * ensureFreshAccessToken() can tell a timeout/network hiccup apart from a
 * genuine rejection by HubSpot — this changes the error's *type*, never its
 * `.message`/`.publicMessage` text for any case that already existed.
 */
async function postForm(url: string, body: Record<string, string>, action: string): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), POSTFORM_TIMEOUT_MS)
  let response: Response
  try {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        signal: controller.signal,
      })
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'AbortError'
      logger.error(isTimeout ? `HubSpot ${action} request timed out` : `HubSpot ${action} request failed`, { action })
      throw new HubspotOauthError(
        isTimeout ? 504 : 502,
        isTimeout
          ? 'Se agotó el tiempo de espera al contactar a HubSpot. Inténtalo de nuevo.'
          : 'No se pudo contactar a HubSpot. Inténtalo de nuevo.',
        isTimeout ? 'timeout' : 'network_error',
      )
    }
  } finally {
    clearTimeout(timeoutHandle)
  }

  if (!response.ok) {
    logger.error(`HubSpot ${action} returned an error status`, { action, status: response.status })
    throw new HubspotOauthError(502, 'HubSpot rechazó la solicitud. Inténtalo de nuevo.', 'rejected')
  }

  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    throw new HubspotOauthError(502, 'HubSpot devolvió una respuesta inesperada.', 'invalid_response')
  }
}

/** Structural validation before anything from this response is trusted/stored — a response missing or misshaping any of these fields is treated as a failure, never partially accepted. */
function parseTokenResponse(json: Record<string, unknown>, context: string): { accessToken: string; expiresInSeconds: number; refreshToken: string | null } {
  const accessToken = json.access_token
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new HubspotOauthError(502, `HubSpot no devolvió un token de acceso válido (${context}).`, 'invalid_response')
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new HubspotOauthError(502, `HubSpot no devolvió una expiración de token válida (${context}).`, 'invalid_response')
  }
  const refreshToken = typeof json.refresh_token === 'string' && json.refresh_token.length > 0 ? json.refresh_token : null
  return { accessToken, expiresInSeconds: expiresIn, refreshToken }
}

/** First leg of the flow — exchanges the one-time `code` HubSpot's redirect carried for a real token pair. */
export async function exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
  requireConfigured()
  const json = await postForm(
    TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.hubspotRedirectUri!,
      client_id: config.hubspotClientId!,
      client_secret: config.hubspotClientSecret!,
    },
    'token exchange',
  )
  const parsed = parseTokenResponse(json, 'intercambio de código')
  if (!parsed.refreshToken) {
    throw new HubspotOauthError(502, 'HubSpot no devolvió un token de actualización válido.', 'invalid_response')
  }
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresInSeconds: parsed.expiresInSeconds }
}

/**
 * Prepared for the sync phase — not called by any route in this phase.
 * Never assumes `refresh_token` rotation happened or didn't: the caller
 * (a later phase's token-refresh service) must overwrite its stored
 * refresh token only when `refreshToken` here is non-null, and keep the
 * previous one otherwise.
 */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
  requireConfigured()
  const json = await postForm(
    TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.hubspotClientId!,
      client_secret: config.hubspotClientSecret!,
    },
    'token refresh',
  )
  const parsed = parseTokenResponse(json, 'renovación de token')
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresInSeconds: parsed.expiresInSeconds }
}

/** Looks up the connected HubSpot account's portal id via introspection — the token exchange response itself never includes it. Called once, right after exchangeCodeForTokens(), before anything is persisted. */
export async function fetchHubPortalId(accessToken: string): Promise<string> {
  requireConfigured()
  const json = await postForm(
    INTROSPECT_URL,
    {
      client_id: config.hubspotClientId!,
      client_secret: config.hubspotClientSecret!,
      token: accessToken,
      token_type_hint: 'access_token',
    },
    'token introspection',
  )
  const hubId = json.hub_id
  if (typeof hubId !== 'number' && typeof hubId !== 'string') {
    throw new HubspotOauthError(502, 'HubSpot no devolvió el identificador del portal conectado.', 'invalid_response')
  }
  return String(hubId)
}

/**
 * Never throws — always resolves to a RevokeResult (see its doc comment
 * for the exact revoked/not-revoked rule) so the disconnect route can
 * decide whether it's safe to remove the local connection. Bounded to
 * REVOKE_TIMEOUT_MS via AbortController so a hung request can't leave the
 * disconnect flow waiting indefinitely.
 *
 * Sends `client_id`, `client_secret`, `token` (the decrypted refresh
 * token), and `token_type_hint: 'refresh_token'` — the exact fields
 * documented on HubSpot's current revoke-token reference page (see the
 * file-level comment above for the URL). Revoking the refresh token
 * invalidates the whole grant, not just the current short-lived access
 * token.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<RevokeResult> {
  if (!config.isHubspotConfigured) {
    return { revoked: false, reason: 'not_configured' }
  }

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.hubspotClientId!,
        client_secret: config.hubspotClientSecret!,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
      signal: controller.signal,
    })
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError'
    logger.warn(isTimeout ? 'HubSpot revoke request timed out' : 'HubSpot revoke request failed')
    return { revoked: false, reason: isTimeout ? 'timeout' : 'network_error' }
  } finally {
    clearTimeout(timeoutHandle)
  }

  if (response.ok) {
    return { revoked: true }
  }

  // Every non-2xx status, 404 included, is treated identically — see
  // RevokeResult's doc comment for why 404 specifically is not trusted as
  // proof of anything.
  logger.warn('HubSpot revoke did not return a 2xx status', { status: response.status })
  return { revoked: false, reason: `http_${response.status}` }
}
