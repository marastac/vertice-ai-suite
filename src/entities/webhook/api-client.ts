import type { WebhookConfigWithOptionalSecret, WebhookConfigWithSecret, WebhookConfiguration, WebhookTestResult } from './types'

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

/**
 * Owner/admin only — the backend re-verifies this from the JWT +
 * organization_members, never trusts the caller. The request never sends
 * a `secret` field (there is nowhere in SaveWebhookConfigParams to put
 * one). The response includes `secret` only the very first time — when
 * this call creates the configuration — never on a later save that only
 * edits url/isActive; see WebhookConfigModal.tsx for how the caller must
 * handle that one-time value.
 */
export async function saveWebhookConfig(accessToken: string, params: SaveWebhookConfigParams): Promise<WebhookConfigWithOptionalSecret> {
  const response = await fetch(`${API_BASE_URL}/api/webhooks/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo guardar la configuración del webhook.'))
  }
  const data = (await response.json()) as ConfigResponseBody & { secret?: string }
  if (!data.config) throw new Error('Respuesta inesperada del servidor.')
  return { config: data.config, secret: data.secret }
}

/**
 * Owner/admin only. Issues a brand-new secret, invalidating the previous
 * one immediately server-side — the only way to recover from a lost
 * secret, since GET /config never includes one. The response always
 * carries the new `secret`, exactly once — see WebhookConfigModal.tsx.
 */
export async function regenerateWebhookSecret(accessToken: string, organizationId: string): Promise<WebhookConfigWithSecret> {
  const response = await fetch(`${API_BASE_URL}/api/webhooks/regenerate-secret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ organizationId }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo regenerar el secreto del webhook.'))
  }
  const data = (await response.json()) as ConfigResponseBody & { secret?: string }
  if (!data.config || !data.secret) throw new Error('Respuesta inesperada del servidor.')
  return { config: data.config, secret: data.secret }
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
