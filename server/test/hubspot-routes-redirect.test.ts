import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression coverage for the explicit "no destinos arbitrarios" (no open
// redirect) requirement on the OAuth callback: frontendRedirectUrl() is the
// ONLY thing routes/hubspot.ts's callback ever passes to res.redirect(),
// and its signature (`status: 'connected' | 'error'`) already makes it a
// compile error to pass anything request-derived. This test pins the
// actual runtime URL shape built from config.frontendUrl.
const FRONTEND_URL = 'https://app.example.test'

let savedFrontendUrl: string | undefined

beforeEach(() => {
  savedFrontendUrl = process.env.FRONTEND_URL
})

afterEach(() => {
  if (savedFrontendUrl === undefined) delete process.env.FRONTEND_URL
  else process.env.FRONTEND_URL = savedFrontendUrl
  vi.resetModules()
})

describe('frontendRedirectUrl', () => {
  it('always redirects to <FRONTEND_URL>/integrations with a fixed status flag — connected', async () => {
    process.env.FRONTEND_URL = FRONTEND_URL
    vi.resetModules()
    const { frontendRedirectUrl } = await import('../src/routes/hubspot.js')
    const url = new URL(frontendRedirectUrl('connected'))
    expect(url.origin).toBe(FRONTEND_URL)
    expect(url.pathname).toBe('/integrations')
    expect(url.searchParams.get('hubspot')).toBe('connected')
  })

  it('always redirects to <FRONTEND_URL>/integrations with a fixed status flag — error', async () => {
    process.env.FRONTEND_URL = FRONTEND_URL
    vi.resetModules()
    const { frontendRedirectUrl } = await import('../src/routes/hubspot.js')
    const url = new URL(frontendRedirectUrl('error'))
    expect(url.origin).toBe(FRONTEND_URL)
    expect(url.pathname).toBe('/integrations')
    expect(url.searchParams.get('hubspot')).toBe('error')
  })

  it('is rooted at whatever FRONTEND_URL is configured to — never a hardcoded domain', async () => {
    process.env.FRONTEND_URL = 'https://a-different-frontend.example.test'
    vi.resetModules()
    const { frontendRedirectUrl } = await import('../src/routes/hubspot.js')
    expect(frontendRedirectUrl('connected').startsWith('https://a-different-frontend.example.test/integrations')).toBe(true)
  })
})
