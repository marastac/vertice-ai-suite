import { z } from 'zod'
import { supabaseAdmin } from '../lib/supabase-client.js'
import type { StoredSession } from './session-repository.js'
import type { SessionSnapshot, SessionSnapshotStore, StoreResult } from '../services/durable-session-sync.js'

/**
 * Supabase implementation of the durable chat-session store
 * (supabase/migrations-backend-chat-sessions.sql). service_role only — the
 * table has no RLS policies and anon/authenticated have no privileges at all.
 * Never throws: every failure comes back as `{ ok: false }`.
 */

export const BACKEND_SESSION_SAVE_TIMEOUT_MS = 5_000
export const BACKEND_SESSION_LOAD_TIMEOUT_MS = 15_000

// Only what recovery needs to trust a row enough to put it back in memory.
const storedSessionShape = z
  .object({
    id: z.uuid(),
    orgSlug: z.string().min(1),
    config: z.object({ assistantName: z.string(), welcomeMessage: z.string() }).loose(),
    createdAt: z.string(),
    updatedAt: z.string(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).loose()),
  })
  .loose()

const recentRowSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid().nullable(),
  org_slug: z.string(),
  state: storedSessionShape,
  version: z.union([z.number(), z.string()]).transform(Number),
  updated_at: z.string(),
})

type RpcClient = { rpc: NonNullable<typeof supabaseAdmin>['rpc'] }

export function createSupabaseSessionSnapshotStore(client: RpcClient | null = supabaseAdmin): SessionSnapshotStore {
  return {
    async save(snapshot: SessionSnapshot): Promise<StoreResult<boolean>> {
      if (!client) return { ok: false, message: 'Supabase is not configured on this backend.' }
      try {
        const { data, error } = await client
          .rpc('save_backend_chat_session', {
            p_id: snapshot.id,
            p_organization_id: snapshot.organizationId,
            p_org_slug: snapshot.orgSlug,
            p_state: snapshot.state,
            p_version: snapshot.version,
          })
          .abortSignal(AbortSignal.timeout(BACKEND_SESSION_SAVE_TIMEOUT_MS))
        if (error) return { ok: false, message: error.message ?? 'Unknown RPC error' }
        if (typeof data !== 'boolean') return { ok: false, message: 'Unexpected save_backend_chat_session response shape' }
        return { ok: true, data }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async loadRecent(sinceIso: string, limit: number): Promise<StoreResult<SessionSnapshot[]>> {
      if (!client) return { ok: false, message: 'Supabase is not configured on this backend.' }
      try {
        const { data, error } = await client
          .rpc('list_recent_backend_chat_sessions', { p_since: sinceIso, p_limit: limit })
          .abortSignal(AbortSignal.timeout(BACKEND_SESSION_LOAD_TIMEOUT_MS))
        if (error) return { ok: false, message: error.message ?? 'Unknown RPC error' }
        if (!Array.isArray(data)) return { ok: false, message: 'Unexpected list_recent_backend_chat_sessions response shape' }
        const snapshots: SessionSnapshot[] = []
        for (const row of data) {
          const parsed = recentRowSchema.safeParse(row)
          // A malformed row is skipped, never allowed to break recovery of the rest.
          if (!parsed.success || parsed.data.state.id !== parsed.data.id) continue
          snapshots.push({
            id: parsed.data.id,
            organizationId: parsed.data.organization_id,
            orgSlug: parsed.data.org_slug,
            state: parsed.data.state as unknown as StoredSession,
            version: parsed.data.version,
          })
        }
        return { ok: true, data: snapshots }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
