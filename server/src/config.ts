import 'dotenv/config'

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

export const config = {
  port: Number(process.env.PORT) || 8787,
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),
  anthropicApiKey,
  anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-8',
  isAiConfigured: Boolean(anthropicApiKey),
  supabaseUrl,
  supabaseServiceRoleKey,
  isWebhooksConfigured: Boolean(supabaseUrl && supabaseServiceRoleKey),
}
