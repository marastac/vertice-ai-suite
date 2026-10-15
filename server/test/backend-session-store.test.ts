import { describe, expect, it, vi } from 'vitest'
import { createSupabaseSessionSnapshotStore } from '../src/repositories/backend-session-store.js'

// Supabase adapter of the durable chat-session store, against a fake RPC
// client (no network). It must never throw and must never let a malformed
// row into memory.

const ID = '33333333-3333-4333-8333-333333333333'
const ORG = '11111111-1111-4111-8111-111111111111'
const STATE = {
  id: ID,
  orgSlug: 'org-a',
  organization: { status: 'resolved', organizationId: ORG },
  config: { assistantName: 'Asistente', welcomeMessage: 'Hola', tone: 'friendly' },
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:01:00.000Z',
  history: [{ role: 'user', content: 'Hola' }],
}

function client(response: { data?: unknown; error?: { message: string } | null } | Error) {
  const abortSignal = vi.fn(async () => {
    if (response instanceof Error) throw response
    return { data: response.data ?? null, error: response.error ?? null }
  })
  const rpc = vi.fn(() => ({ abortSignal }))
  return { rpc, abortSignal } as never as { rpc: ReturnType<typeof vi.fn>; abortSignal: ReturnType<typeof vi.fn> }
}

describe('createSupabaseSessionSnapshotStore', () => {
  it('save() sends the snapshot to save_backend_chat_session with a timeout and returns whether it applied', async () => {
    const fake = client({ data: true })
    const store = createSupabaseSessionSnapshotStore(fake as never)
    const result = await store.save({ id: ID, organizationId: ORG, orgSlug: 'org-a', state: STATE as never, version: 7 })
    expect(result).toEqual({ ok: true, data: true })
    expect(fake.rpc).toHaveBeenCalledWith('save_backend_chat_session', {
      p_id: ID,
      p_organization_id: ORG,
      p_org_slug: 'org-a',
      p_state: STATE,
      p_version: 7,
    })
    expect(fake.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('save() reports database errors, unexpected shapes and thrown timeouts — never throws', async () => {
    const snapshot = { id: ID, organizationId: null, orgSlug: 'o', state: STATE as never, version: 1 }
    await expect(createSupabaseSessionSnapshotStore(client({ error: { message: 'permission denied' } }) as never).save(snapshot)).resolves.toEqual({ ok: false, message: 'permission denied' })
    await expect(createSupabaseSessionSnapshotStore(client({ data: 'yes' }) as never).save(snapshot)).resolves.toMatchObject({ ok: false })
    await expect(createSupabaseSessionSnapshotStore(client(new Error('The operation was aborted due to timeout')) as never).save(snapshot)).resolves.toMatchObject({ ok: false })
    await expect(createSupabaseSessionSnapshotStore(null).save(snapshot)).resolves.toMatchObject({ ok: false })
  })

  it('loadRecent() returns valid rows and SKIPS malformed or mismatched ones', async () => {
    const rows = [
      { id: ID, organization_id: ORG, org_slug: 'org-a', state: STATE, version: '12', updated_at: '2026-10-14T00:01:00Z' },
      { id: '44444444-4444-4444-8444-444444444444', organization_id: null, org_slug: 'x', state: { id: 'other' }, version: 1, updated_at: 'x' },
      { id: '55555555-5555-4555-8555-555555555555', organization_id: null, org_slug: 'x', state: STATE, version: 1, updated_at: 'x' },
      { nonsense: true },
    ]
    const fake = client({ data: rows })
    const result = await createSupabaseSessionSnapshotStore(fake as never).loadRecent('2026-10-01T00:00:00Z', 100)
    expect(fake.rpc).toHaveBeenCalledWith('list_recent_backend_chat_sessions', { p_since: '2026-10-01T00:00:00Z', p_limit: 100 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toMatchObject({ id: ID, organizationId: ORG, version: 12 })
    expect(result.data[0].state.history).toEqual([{ role: 'user', content: 'Hola' }])
  })

  it('loadRecent() failures come back as ok:false', async () => {
    await expect(createSupabaseSessionSnapshotStore(client({ error: { message: 'down' } }) as never).loadRecent('x', 1)).resolves.toEqual({ ok: false, message: 'down' })
    await expect(createSupabaseSessionSnapshotStore(client({ data: { not: 'an array' } }) as never).loadRecent('x', 1)).resolves.toMatchObject({ ok: false })
    await expect(createSupabaseSessionSnapshotStore(client(new Error('network')) as never).loadRecent('x', 1)).resolves.toMatchObject({ ok: false })
  })
})
