import type { WebhookConfiguration, WebhookTestResult } from './types'

// Same pattern as entities/chat/api-client.ts — the one other place this
// frontend calls the Express backend directly.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787'

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null)
  return (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error) || fallback
}

interface ConfigResponseBody {
  config: WebhookConfiguration | null
}

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` }
}

/** Any organization role may call this — the backend's GET /api/webhooks/config only requires membership, not owner/admin (see server/src/routes/webhooks.ts). */
export async function fetchWebhookConfig(accessToken: string, organizationId: string): Promise<WebhookConfiguration | null> {
  const response = await fetch(`${API_BASE_URL}/api/webhooks/config?organizationId=${encodeURIComponent(organizationId)}`, {
    headers: authHeaders(accessToken),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo cargar la configuración del webhook.'))
  }
  const data = (await response.json()) as ConfigResponseBody
  return data.config
}

export interface SaveWebhookConfigParams {
  organizationId: string
  url: string
  isActive: boolean
}

/** Owner/admin only — the backend re-verifies this from the JWT + organization_members, never trusts the caller. Never sends/receives a `secret` field. */
export async function saveWebhookConfig(accessToken: string, params: SaveWebhookConfigParams): Promise<WebhookConfiguration> {
  const response = await fetch(`${API_BASE_URL}/api/webhooks/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo guardar la configuración del webhook.'))
  }
  const data = (await response.json()) as ConfigResponseBody
  if (!data.config) throw new Error('Respuesta inesperada del servidor.')
  return data.config
}

/** Owner/admin only. Sends one signed test request immediately, server-side — never touches `leads` or the delivery outbox. */
export async function testWebhook(accessToken: string, organizationId: string): Promise<WebhookTestResult> {
  const response = await fetch(`${API_BASE_URL}/api/webhooks/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ organizationId }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo probar el webhook.'))
  }
  return (await response.json()) as WebhookTestResult
}
