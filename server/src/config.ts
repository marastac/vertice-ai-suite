import 'dotenv/config'
import { logger } from './lib/logger.js'
import { parseHubspotEncryptionKey } from './lib/hubspot-crypto.js'

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return ['http://localhost:5173']
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined

// Webhooks feature: the backend's own Supabase credentials, used only for
// webhook_configurations/webhook_deliveries (config CRUD, the delivery
// worker's claim/write). Nothing else in this backend touches Supabase.
// Deliberately optional at startup — see supabaseUrl/supabaseServiceRoleKey
// below and lib/supabase-client.ts's isWebhooksConfigured: an unconfigured
// deployment must still serve the existing chat/Anthropic routes normally,
// the same way a missing ANTHROPIC_API_KEY doesn't crash the process either.
const supabaseUrl = process.env.SUPABASE_URL?.trim() || undefined
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined

// HubSpot CRM integration (Fase 1 of several — see the integration audit):
// OAuth client credentials, the callback target, the frontend URL to
// redirect back to after a successful connection, and the app-level token
// encryption key. All deliberately optional at startup, same reasoning as
// the Webhooks feature above — an unconfigured deployment must keep
// serving every other route (leads, forms, chat, webhooks) normally.
// Nothing here is ever read by frontend code — none of these are VITE_-
// prefixed, and nothing under server/ is ever bundled into the browser.
const hubspotClientId = process.env.HUBSPOT_CLIENT_ID?.trim() || undefined
const hubspotClientSecret = process.env.HUBSPOT_CLIENT_SECRET?.trim() || undefined
const hubspotRedirectUri = process.env.HUBSPOT_REDIRECT_URI?.trim() || undefined
// Where the OAuth callback redirects the browser after connecting/failing
// to connect — not itself a HubSpot setting, but required for that flow to
// complete, so it's treated as part of "is HubSpot configured" below.
const frontendUrl = process.env.FRONTEND_URL?.trim() || undefined
const hubspotTokenEncryptionKey = parseHubspotEncryptionKey(process.env.HUBSPOT_TOKEN_ENCRYPTION_KEY)

if (process.env.HUBSPOT_TOKEN_ENCRYPTION_KEY && !hubspotTokenEncryptionKey) {
  // Set but malformed (wrong decoded length / not valid base64) — this
  // must never crash the process, exactly like every other optional
  // feature in this file; isHubspotConfigured below simply stays false
  // until it's fixed. Deliberately never logs the raw value.
  logger.warn(
    'HUBSPOT_TOKEN_ENCRYPTION_KEY is set but is not a valid 32-byte base64 key — the HubSpot integration will stay disabled until this is fixed.',
  )
}

export const config = {
  port: Number(process.env.PORT) || 8787,
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),
  anthropicApiKey,
  anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-8',
  isAiConfigured: Boolean(anthropicApiKey),
  supabaseUrl,
  supabaseServiceRoleKey,
  isWebhooksConfigured: Boolean(supabaseUrl && supabaseServiceRoleKey),
  hubspotClientId,
  hubspotClientSecret,
  hubspotRedirectUri,
  frontendUrl,
  hubspotTokenEncryptionKey,
  isHubspotConfigured: Boolean(
    hubspotClientId && hubspotClientSecret && hubspotRedirectUri && frontendUrl && hubspotTokenEncryptionKey,
  ),
}
