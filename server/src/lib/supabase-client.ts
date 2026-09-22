import { createClient } from '@supabase/supabase-js'
import type { WebSocketLikeConstructor } from '@supabase/supabase-js'
import WebSocket from 'ws'
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
 *
 * `realtime.transport` is explicitly provided here even though this
 * backend never uses Realtime (no `.channel()`/`.subscribe()` anywhere —
 * only `.from()`/`.rpc()`). `SupabaseClient`'s constructor unconditionally
 * builds an internal `RealtimeClient` regardless of whether Realtime is
 * ever used, and as of `@supabase/realtime-js` 2.116.0 that constructor
 * requires a global `WebSocket` when no transport is given — available
 * natively only on Node >=22. This project's backend still targets Node
 * 20 (see server/package.json's engines field), so without this, the
 * eager RealtimeClient construction throws synchronously at import time
 * ("Node.js detected but native WebSocket not found"), crashing the whole
 * process before it ever starts listening. Passing the `ws` package here
 * satisfies that same official, typed `transport` option and avoids the
 * crash without touching the Node runtime — Realtime itself is still
 * never actually used.
 *
 * The cast below is required, not stylistic: `ws`'s `WebSocket` class has
 * an additional server-mode constructor overload (`new (address: null)`)
 * that `WebSocketLikeConstructor` (client-only, `new (address: string |
 * URL, ...)`) doesn't declare, so TypeScript rejects a direct assignment.
 * `ws`'s own docs list itself as the standard Node WebSocket
 * implementation for exactly this kind of client usage, so the shapes are
 * runtime-compatible even though the two independently-authored type
 * declarations aren't structurally identical.
 */
export const supabaseAdmin = config.isWebhooksConfigured
  ? createClient(config.supabaseUrl!, config.supabaseServiceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
    })
  : null
