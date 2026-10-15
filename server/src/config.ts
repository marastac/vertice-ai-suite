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

// Technical protection, NOT a commercial plan limit — see
// chat-service.ts::hasReachedMessageLimit(). Global for every organization,
// same "plain constant, optionally env-overridden" pattern as PORT below.
// Guards more than PORT's bare `|| fallback` would: a malformed or
// non-positive value (e.g. "0", "-5", unset, garbage) must never silently
// become a limit that blocks every conversation from its first message —
// it falls back to 25 instead.
const chatMaxUserMessagesPerConversation = (() => {
  const parsed = Number(process.env.CHAT_MAX_USER_MESSAGES)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 25
})()

// Global kill switch for per-organization monthly quotas (see
// services/quota-service.ts and supabase/migrations-usage-quotas.sql).
// OFF unless explicitly set to "true" (case-insensitive) — any other value,
// including unset, malformed, "1" or "yes", keeps it off. While off, the
// chat never calls any quota RPC or reads any quota table, so it works
// exactly as before and does not require that migration to be applied.
const chatQuotasEnabled = process.env.CHAT_QUOTAS_ENABLED?.trim().toLowerCase() === 'true'

// Abuse protection for the PUBLIC chat, independent of quotas: a per-IP cap
// on new conversations and "one message in flight per conversation" (see
// routes/chat.ts and chat-service.ts::tryBeginSessionTurn()). A real visitor
// opens one conversation per page load and the official frontend never sends
// two messages at once, so neither ever blocks legitimate use. ON unless set
// to exactly "off" (case-insensitive) — an emergency switch, not a tuning knob.
const chatAbuseGuardsEnabled = process.env.CHAT_ABUSE_GUARDS?.trim().toLowerCase() !== 'off'

// Optional GLOBAL circuit breaker on chat messages per minute across every
// visitor and organization — caps Anthropic spend during a distributed abuse
// burst that per-IP limits can't see. Off (0) unless set to a positive integer.
const chatGlobalMaxMessagesPerMinute = (() => {
  const parsed = Number(process.env.CHAT_GLOBAL_MAX_MESSAGES_PER_MINUTE)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
})()

// Webhooks feature: the backend's own Supabase credentials, used only for
// webhook_configurations/webhook_deliveries (config CRUD, the delivery
// worker's claim/write). Nothing else in this backend touches Supabase.
// Deliberately optional at startup — see supabaseUrl/supabaseServiceRoleKey
// below and lib/supabase-client.ts's isWebhooksConfigured: an unconfigured
// deployment must still serve the existing chat/Anthropic routes normally,
// the same way a missing ANTHROPIC_API_KEY doesn't crash the process either.
const supabaseUrl = process.env.SUPABASE_URL?.trim() || undefined

// Where chat sessions are kept durably. 'file' (default): only
// server/data/sessions.json, as always. 'postgres': ALSO mirrored to the
// backend_chat_sessions table (supabase/migrations-backend-chat-sessions.sql)
// and recovered from it at startup — see services/durable-session-sync.ts.
// Requires SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and that migration; any
// other value is 'file'.
const chatSessionStore: 'file' | 'postgres' = process.env.CHAT_SESSION_STORE?.trim().toLowerCase() === 'postgres' ? 'postgres' : 'file'
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
  chatMaxUserMessagesPerConversation,
  chatQuotasEnabled,
  chatAbuseGuardsEnabled,
  chatSessionStore,
  chatGlobalMaxMessagesPerMinute,
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
