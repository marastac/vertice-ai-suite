import type { HubspotConnection } from './types'

// Same pattern as entities/webhook/api-client.ts — the Express backend
// this frontend calls directly.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787'

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null)
  return (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error) || fallback
}

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` }
}

interface ConnectionResponseBody {
  connection: HubspotConnection | null
}

/** Any organization role may call this — the backend's GET /api/hubspot/connection only requires membership, not owner/admin (see server/src/routes/hubspot.ts). Never includes any token, encrypted or otherwise. */
export async function fetchHubspotConnection(accessToken: string, organizationId: string): Promise<HubspotConnection | null> {
  const response = await fetch(`${API_BASE_URL}/api/hubspot/connection?organizationId=${encodeURIComponent(organizationId)}`, {
    headers: authHeaders(accessToken),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo cargar el estado de la conexión con HubSpot.'))
  }
  const data = (await response.json()) as ConnectionResponseBody
  return data.connection
}

interface StartOauthResponseBody {
  url: string
}

/**
 * Owner/admin only — the backend re-verifies this from the JWT +
 * organization_members, never trusts the caller. Returns HubSpot's own
 * consent screen URL; this function only makes the API call — the caller
 * (HubspotIntegrationCard) is responsible for the actual
 * `window.location.href` navigation, a real top-level browser navigation,
 * never a fetch to that URL.
 */
export async function startHubspotOauth(accessToken: string, organizationId: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/hubspot/oauth/start?organizationId=${encodeURIComponent(organizationId)}`, {
    headers: authHeaders(accessToken),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo iniciar la conexión con HubSpot.'))
  }
  const data = (await response.json()) as StartOauthResponseBody
  if (!data.url) throw new Error('Respuesta inesperada del servidor.')
  return data.url
}

/**
 * Owner/admin only. The backend attempts revocation with HubSpot first and
 * only removes the local connection once HubSpot confirms it (2xx) — see
 * server/src/routes/hubspot.ts's disconnectHubspotConnection(). A rejected
 * promise here means the connection was deliberately KEPT, not lost —
 * surface the error and let the admin retry, never assume disconnection
 * happened.
 */
export async function disconnectHubspot(accessToken: string, organizationId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/hubspot/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ organizationId }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo desconectar HubSpot.'))
  }
}
