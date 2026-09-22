import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'

/**
 * service_role client — bypasses RLS entirely. Used ONLY by the webhook
 * feature (config repository, delivery worker). Every write this client
 * makes is preceded by an explicit application-level membership+role check
 * (see services/webhook-auth.ts) — RLS on webhook_configurations/
 * webhook_deliveries exists as defense in depth (see
 * supabase/migrations-webhooks.sql), not as this client's authorization
 * boundary, since service_role bypasses it regardless.
 *
 * `null` when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY aren't set — callers
 * must check isWebhooksConfigured first (routes/webhooks.ts and
 * webhook-worker.ts both do). Mirrors ai-provider.ts's isConfigured
 * pattern: an unconfigured Webhooks feature must never crash the whole
 * backend or block the existing chat/Anthropic routes from working.
 */
export const supabaseAdmin = config.isWebhooksConfigured
  ? createClient(config.supabaseUrl!, config.supabaseServiceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null
