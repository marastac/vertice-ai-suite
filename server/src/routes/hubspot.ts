import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { createRateLimiter } from '../lib/rate-limit.js'
import { AppError } from '../lib/errors.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { decryptHubspotToken, encryptHubspotToken } from '../lib/hubspot-crypto.js'
import { hubspotRepository } from '../repositories/hubspot-repository.js'
// Generic JWT + organization-membership + role helpers — not webhook-
// specific despite living in webhook-auth.ts (see the HubSpot integration
// audit's note on this). Reused here rather than duplicated, per explicit
// direction for this phase: this is the same authentication/authorization
// boundary every other authenticated route in this backend already uses.
import { requireAdminRole, requireAuthenticatedUser, requireOrganizationMembership } from '../services/webhook-auth.js'
import { buildAuthorizeUrl, exchangeCodeForTokens, fetchHubPortalId, revokeRefreshToken } from '../services/hubspot-oauth.js'
import { hubspotDisconnectBodySchema, hubspotOrganizationQuerySchema } from '../schemas/hubspot.js'

export const hubspotRouter = Router()

// Same floor-against-abuse reasoning as webhooksRouter — authenticated,
// dashboard-only endpoints, but still worth a limit against a runaway
// frontend retry loop or a compromised session. Applies to /oauth/callback
// too (public, HubSpot-initiated) — a legitimate flow hits it once per
// connection attempt, so this is harmless there and consistent with every
// other route in this router.
const rateLimit = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 60 })
hubspotRouter.use(rateLimit)

const STATE_TTL_MS = 10 * 60_000

/**
 * Exported (only) so tests can confirm this always builds a fixed URL
 * rooted at config.frontendUrl — never a caller/request-supplied
 * destination. The `status` parameter's type (`'connected' | 'error'`)
 * already makes anything else a compile error; the test exists to pin the
 * actual runtime URL shape, not to re-prove what the type system already
 * guarantees.
 */
export function frontendRedirectUrl(status: 'connected' | 'error'): string {
  const url = new URL('/integrations', config.frontendUrl!)
  url.searchParams.set('hubspot', status)
  return url.toString()
}

/**
 * Owner/admin only — mints a short-lived, single-use `state` bound to this
 * organization and this caller, persisted in hubspot_oauth_states (never
 * an in-memory Map — see migrations-hubspot-oauth-state.sql for why a
 * Railway restart makes that unsafe), and returns the HubSpot consent
 * screen URL. Never redirects itself — the frontend does
 * `window.location.href = url`, a real top-level navigation, not a fetch.
 */
hubspotRouter.get('/oauth/start', async (req, res, next) => {
  try {
    if (!config.isHubspotConfigured) {
      throw new AppError(503, 'La integración con HubSpot no está configurada en el servidor todavía.')
    }
    const query = hubspotOrganizationQuerySchema.parse(req.query)
    const user = await requireAuthenticatedUser(req)
    const role = await requireOrganizationMembership(user.id, query.organizationId)
    requireAdminRole(role)

    const state = randomBytes(32).toString('hex')
    await hubspotRepository.createOauthState({
      state,
      organizationId: query.organizationId,
      userId: user.id,
      expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
    })

    res.json({ url: buildAuthorizeUrl(state) })
  } catch (error) {
    next(error)
  }
})

export type OauthCallbackStatus = 'connected' | 'error'

/**
 * The full callback flow, extracted from the route handler so it's
 * directly testable (mocking hubspotRepository/webhook-auth/hubspot-oauth)
 * without an HTTP harness — this project has none. Returns a plain status
 * enum; the route wraps it in a redirect, never anything else.
 *
 * Order of checks, each one a hard gate — a failure at any step aborts
 * immediately, never falls through to a later step:
 *   1. `state` present at all.
 *   2. `state` atomically consumed (rejects unknown/expired/already-used —
 *      see hubspotRepository.consumeOauthState()'s doc comment for the
 *      atomicity argument).
 *   3. HubSpot didn't report a consent error, and a `code` is present.
 *   4. The user who started the flow (from the now-consumed state row) is
 *      STILL owner/admin of that organization — re-checked here, not
 *      assumed from ten minutes ago, since their role could have changed
 *      (demoted, removed) in the window between /oauth/start and this
 *      callback. Checked BEFORE exchanging the code, so a caller who lost
 *      access never causes a token to be minted for nothing.
 *   5. Token exchange, portal-id lookup, encryption, and storage all
 *      succeed.
 */
export async function handleOauthCallback(params: { state?: string; code?: string; error?: string }): Promise<OauthCallbackStatus> {
  if (!params.state) return 'error'

  let consumed: { organizationId: string; userId: string } | null
  try {
    consumed = await hubspotRepository.consumeOauthState(params.state)
  } catch (error) {
    logger.error('Failed to consume HubSpot OAuth state', { message: error instanceof Error ? error.message : String(error) })
    return 'error'
  }

  if (!consumed) {
    // Unknown, expired, or already-consumed — never distinguish which to
    // the browser. There is no retry path on the same state either way;
    // the admin simply starts over from "Conectar".
    return 'error'
  }

  if (params.error || !params.code) {
    // The admin denied consent, or HubSpot sent something malformed. The
    // state was already consumed above — correct: it must never be usable
    // again regardless of why this branch was reached.
    return 'error'
  }

  try {
    const role = await requireOrganizationMembership(consumed.userId, consumed.organizationId)
    requireAdminRole(role)
  } catch {
    // The caller who started this flow is no longer a member, or was
    // demoted below admin, sometime in the (short, but real) window this
    // state was alive. Reject before ever exchanging the code — no token
    // is minted for a connection that's about to be refused anyway.
    logger.warn('HubSpot OAuth callback rejected — the user who started the flow is no longer owner/admin', {
      organizationId: consumed.organizationId,
    })
    return 'error'
  }

  try {
    const tokens = await exchangeCodeForTokens(params.code)
    const hubPortalId = await fetchHubPortalId(tokens.accessToken)

    const accessTokenEncrypted = encryptHubspotToken(tokens.accessToken, config.hubspotTokenEncryptionKey!)
    const refreshTokenEncrypted = encryptHubspotToken(tokens.refreshToken, config.hubspotTokenEncryptionKey!)

    await hubspotRepository.upsertConnection({
      organizationId: consumed.organizationId,
      hubPortalId,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
      scopes: 'crm.objects.contacts.write',
      connectedBy: consumed.userId,
    })

    return 'connected'
  } catch (error) {
    // Known, accepted edge case: if exchangeCodeForTokens() succeeded but
    // a later step (introspect, encrypt, or the DB write) fails, the
    // freshly issued token pair is never stored anywhere and simply goes
    // unused — HubSpot's own "Connected apps" list would show the app as
    // authorized with no corresponding Lead AI record. This is not a
    // security issue (no token is exposed or persisted insecurely) and
    // resolves itself the moment the admin retries "Conectar"; adding a
    // best-effort cleanup revoke here would be extra complexity for a
    // narrow, self-healing failure window.
    logger.error('HubSpot OAuth callback failed after consuming state', {
      organizationId: consumed.organizationId,
      message: error instanceof Error ? error.message : String(error),
    })
    return 'error'
  }
}

/**
 * Public — HubSpot's own redirect carries no Bearer token, so this cannot
 * go through requireAuthenticatedUser(). The `state` itself, atomically
 * consumed and bound server-side to the organization/user that started the
 * flow (and re-verified as still owner/admin — see handleOauthCallback()),
 * is the entire authentication for this endpoint.
 *
 * Always ends in a redirect to a FIXED frontend URL built from
 * config.frontendUrl — never a URL derived from the request, so this can
 * never be used as an open redirect.
 */
hubspotRouter.get('/oauth/callback', async (req, res) => {
  if (!config.isHubspotConfigured) {
    // Nothing sensible to redirect to if FRONTEND_URL itself isn't known.
    res.status(503).send('La integración con HubSpot no está configurada.')
    return
  }

  const status = await handleOauthCallback({
    state: typeof req.query.state === 'string' ? req.query.state : undefined,
    code: typeof req.query.code === 'string' ? req.query.code : undefined,
    error: typeof req.query.error === 'string' ? req.query.error : undefined,
  })

  res.redirect(frontendRedirectUrl(status))
})

/** Any organization member may read the (token-free) connection status — matches the "member/viewer solo lectura" requirement. */
hubspotRouter.get('/connection', async (req, res, next) => {
  try {
    const query = hubspotOrganizationQuerySchema.parse(req.query)
    const user = await requireAuthenticatedUser(req)
    await requireOrganizationMembership(user.id, query.organizationId)

    const connection = await hubspotRepository.getPublicConnection(query.organizationId)
    res.json({ connection })
  } catch (error) {
    next(error)
  }
})

/**
 * Extracted from the route handler for the same testability reason as
 * handleOauthCallback() above. Throws AppError (caught by the route's
 * `next(error)`) whenever the connection must be KEPT — a thrown error
 * here always means "nothing was deleted, the admin can retry" — and only
 * returns normally once the local connection has actually been removed.
 */
export async function disconnectHubspotConnection(organizationId: string): Promise<{ disconnected: true; revoked: boolean }> {
  const connection = await hubspotRepository.getConnection(organizationId)
  if (!connection) {
    throw new AppError(404, 'No hay ninguna conexión con HubSpot configurada todavía.')
  }

  if (!config.hubspotTokenEncryptionKey) {
    throw new AppError(503, 'La integración con HubSpot no está configurada en el servidor todavía.')
  }

  let refreshToken: string
  try {
    refreshToken = decryptHubspotToken(connection.refresh_token_encrypted, config.hubspotTokenEncryptionKey)
  } catch (error) {
    // Cannot even attempt revocation without the plaintext token — this is
    // NOT grounds to delete the local connection; keep it and surface a
    // clear error, same as any other case where HubSpot's confirmation
    // couldn't be obtained.
    logger.error('Could not decrypt HubSpot refresh token before revoke — connection kept', {
      organizationId,
      message: error instanceof Error ? error.message : String(error),
    })
    throw new AppError(502, 'No se pudo verificar el token guardado. La conexión se conservó — inténtalo de nuevo.')
  }

  const revokeResult = await revokeRefreshToken(refreshToken)
  if (!revokeResult.revoked) {
    // Anything short of a confirmed 2xx — 404, any other status, a
    // network error, or a timeout — means HubSpot never confirmed the
    // token is gone. The connection is kept exactly as requested: an
    // admin can retry "Desconectar" instead of silently losing the
    // connection to a transient failure or an ambiguous response.
    logger.warn('HubSpot revoke was not confirmed — connection kept for retry', {
      organizationId,
      reason: revokeResult.reason,
    })
    throw new AppError(502, 'No se pudo confirmar la revocación con HubSpot. La conexión se conservó — inténtalo de nuevo.')
  }

  await hubspotRepository.deleteConnection(organizationId)
  return { disconnected: true, revoked: true }
}

/**
 * Owner/admin only. See disconnectHubspotConnection()'s doc comment for
 * the conserve-unless-confirmed policy this enforces.
 */
hubspotRouter.post('/disconnect', async (req, res, next) => {
  try {
    const body = hubspotDisconnectBodySchema.parse(req.body)
    const user = await requireAuthenticatedUser(req)
    const role = await requireOrganizationMembership(user.id, body.organizationId)
    requireAdminRole(role)

    const result = await disconnectHubspotConnection(body.organizationId)
    res.json(result)
  } catch (error) {
    next(error)
  }
})
