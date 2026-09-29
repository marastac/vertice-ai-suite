import { afterEach, describe, expect, it, vi } from 'vitest'

// resolveOrganizationIdForSlug() is the ONLY place a chat session's
// organization attribution gets derived — a real, authoritative lookup
// against Supabase's own `organizations` table, never an invented/guessed
// association. It returns a discriminated OrganizationResolution with FOUR
// deliberately distinct states — 'resolved' | 'not_configured' |
// 'not_found' | 'unavailable' — so callers (chat-service.ts) can tell apart
// four situations that each require different behavior:
//   - resolved: safe to call Anthropic and attribute usage to a real org.
//   - not_configured: no Supabase at all for this deployment (dev/local) —
//     safe to call Anthropic, but nothing to record usage against.
//   - not_found: Supabase IS configured, the query worked, but no row
//     matches — a CONFIRMED absence. Must NEVER be retried repeatedly (it
//     is settled, not transient) and must block Anthropic.
//   - unavailable: Supabase IS configured but the query itself failed even
//     after one retry — genuinely unknown. Also blocks Anthropic, but
//     UNLIKE not_found is eligible for a fresh attempt later.
// The critical distinction the test suite protects: not_found is NEVER
// converted into unavailable, and vice versa — they are reached through
// different code paths (a successful empty result vs. a failed query) and
// must stay reachable independently.

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../src/lib/supabase-client.js')
  vi.doUnmock('../src/lib/logger.js')
})

function mockSupabaseOrganizationsQuery(...results: { data: { id: string } | null; error: { message: string } | null }[]) {
  const maybeSingle = vi.fn()
  for (const result of results) maybeSingle.mockResolvedValueOnce(result)
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
  return { from, select, eq, maybeSingle }
}

describe('resolveOrganizationIdForSlug', () => {
  it('returns { status: "not_configured" } when Supabase is not configured for this deployment (dev/local mode)', async () => {
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: null }))
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    await expect(resolveOrganizationIdForSlug('vertice-agency')).resolves.toEqual({ status: 'not_configured' })
  })

  it('returns { status: "resolved", organizationId } when the slug matches a row', async () => {
    const { from, eq } = mockSupabaseOrganizationsQuery({ data: { id: 'org-real-uuid' }, error: null })
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    const result = await resolveOrganizationIdForSlug('acme')

    expect(result).toEqual({ status: 'resolved', organizationId: 'org-real-uuid' })
    expect(from).toHaveBeenCalledWith('organizations')
    expect(eq).toHaveBeenCalledWith('slug', 'acme')
  })

  it('returns { status: "not_found" } when Supabase IS configured but no organization matches the slug (a fabricated/nonexistent slug)', async () => {
    const { maybeSingle } = mockSupabaseOrganizationsQuery({ data: null, error: null })
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    await expect(resolveOrganizationIdForSlug('does-not-exist')).resolves.toEqual({ status: 'not_found' })
    // A confirmed empty result is settled on the FIRST successful query —
    // never retried, unlike a query failure (see the "does not retry
    // not_found" test below for the same assertion from the caller's side).
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  it('recovers and returns "resolved" if the FIRST attempt errors but a single retry succeeds', async () => {
    const { maybeSingle } = mockSupabaseOrganizationsQuery(
      { data: null, error: { message: 'connection reset' } },
      { data: { id: 'org-real-uuid' }, error: null },
    )
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    const result = await resolveOrganizationIdForSlug('acme')

    expect(result).toEqual({ status: 'resolved', organizationId: 'org-real-uuid' })
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })

  it('returns { status: "unavailable" } (never throws, never "not_found") when the query fails on every attempt — a genuine transient outage', async () => {
    mockSupabaseOrganizationsQuery(
      { data: null, error: { message: 'connection error' } },
      { data: null, error: { message: 'connection error' } },
    )
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    await expect(resolveOrganizationIdForSlug('acme')).resolves.toEqual({ status: 'unavailable' })
  })

  it('does not retry more than once on a query failure — at most two total attempts (no retry system, no backoff)', async () => {
    const { maybeSingle } = mockSupabaseOrganizationsQuery(
      { data: null, error: { message: 'connection error' } },
      { data: null, error: { message: 'connection error' } },
    )
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    await resolveOrganizationIdForSlug('acme')

    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })

  it('returns { status: "unavailable" } and never throws when the client itself throws synchronously on every attempt', async () => {
    const from = vi.fn(() => {
      throw new Error('boom')
    })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    await expect(resolveOrganizationIdForSlug('acme')).resolves.toEqual({ status: 'unavailable' })
  })

  it('never logs the org slug or any sensitive value — only a sanitized error message', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    mockSupabaseOrganizationsQuery(
      { data: null, error: { message: 'connection error' } },
      { data: null, error: { message: 'connection error' } },
    )
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    await resolveOrganizationIdForSlug('secret-org-slug')

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
    const loggedText = JSON.stringify(loggerWarnSpy.mock.calls)
    expect(loggedText).not.toContain('secret-org-slug')
  })

  it('never logs anything (no warn call at all) for a confirmed not_found — it is not treated as a warning-worthy failure', async () => {
    const loggerWarnSpy = vi.fn()
    vi.doMock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: loggerWarnSpy, error: vi.fn() } }))
    mockSupabaseOrganizationsQuery({ data: null, error: null })
    const { resolveOrganizationIdForSlug } = await import('../src/services/organization-lookup.js')

    await resolveOrganizationIdForSlug('does-not-exist')

    expect(loggerWarnSpy).not.toHaveBeenCalled()
  })
})
