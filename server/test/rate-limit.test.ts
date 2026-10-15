import { describe, expect, it, vi } from 'vitest'
import { createRateLimiter, onlyWhen } from '../src/lib/rate-limit.js'

// createRateLimiter() is the exact, unmodified mechanism routes/forms.ts
// reuses for public form submissions (same as chat/webhooks/hubspot
// already do) — this is its first direct unit test in this project (it was
// previously only exercised indirectly through those routes). Tested here
// against plain mocked Express-shaped req/res objects, since this project
// has no HTTP test harness.

function buildReqRes(ip: string) {
  const req = { ip } as unknown as Parameters<ReturnType<typeof createRateLimiter>>[0]
  const headers: Record<string, string> = {}
  const res = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value
    }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Parameters<ReturnType<typeof createRateLimiter>>[1]
  const next = vi.fn()
  return { req, res, next, headers }
}

describe('createRateLimiter', () => {
  it('allows requests under the max, calling next() each time', () => {
    const rateLimit = createRateLimiter({ windowMs: 60_000, max: 3 })
    const { req, res, next } = buildReqRes('1.2.3.4')

    rateLimit(req, res, next)
    rateLimit(req, res, next)
    rateLimit(req, res, next)

    expect(next).toHaveBeenCalledTimes(3)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 429 once the max is exceeded for the same IP, with a Retry-After header, and does not call next()', () => {
    const rateLimit = createRateLimiter({ windowMs: 60_000, max: 2 })
    const { req, res, next } = buildReqRes('5.6.7.8')

    rateLimit(req, res, next) // 1
    rateLimit(req, res, next) // 2
    rateLimit(req, res, next) // 3 -> blocked

    expect(next).toHaveBeenCalledTimes(2)
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }))
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String))
  })

  it('tracks each IP independently — one IP being blocked never affects another', () => {
    const rateLimit = createRateLimiter({ windowMs: 60_000, max: 1 })
    const first = buildReqRes('9.9.9.9')
    const second = buildReqRes('10.10.10.10')

    rateLimit(first.req, first.res, first.next) // allowed
    rateLimit(first.req, first.res, first.next) // blocked for this IP
    rateLimit(second.req, second.res, second.next) // still allowed — different IP

    expect(first.next).toHaveBeenCalledTimes(1)
    expect(first.res.status).toHaveBeenCalledWith(429)
    expect(second.next).toHaveBeenCalledTimes(1)
    expect(second.res.status).not.toHaveBeenCalled()
  })

  it('resets the count after the window elapses', () => {
    vi.useFakeTimers()
    try {
      const rateLimit = createRateLimiter({ windowMs: 1_000, max: 1 })
      const { req, res, next } = buildReqRes('1.1.1.1')

      rateLimit(req, res, next) // allowed
      rateLimit(req, res, next) // blocked
      expect(res.status).toHaveBeenCalledWith(429)

      vi.advanceTimersByTime(1_001)

      rateLimit(req, res, next) // window reset — allowed again
      expect(next).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a fixed key when req.ip is undefined, rather than throwing', () => {
    const rateLimit = createRateLimiter({ windowMs: 60_000, max: 5 })
    const { req, res, next } = buildReqRes(undefined as unknown as string)

    expect(() => rateLimit(req, res, next)).not.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('createRateLimiter — custom message', () => {
  it('uses the given 429 message instead of the default one', () => {
    const rateLimit = createRateLimiter({ windowMs: 60_000, max: 1, message: 'Mensaje propio.' })
    const { req, res, next } = buildReqRes('9.9.9.1')

    rateLimit(req, res, next)
    rateLimit(req, res, next)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.json).toHaveBeenCalledWith({ error: 'Mensaje propio.' })
  })
})

describe('onlyWhen', () => {
  it('passes straight through (never touching the limiter) while disabled', () => {
    const inner = vi.fn()
    const middleware = onlyWhen(() => false, inner)
    const { req, res, next } = buildReqRes('9.9.9.2')

    middleware(req, res, next)

    expect(inner).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('applies the wrapped limiter while enabled, re-evaluating the condition on every request', () => {
    let enabled = true
    const middleware = onlyWhen(() => enabled, createRateLimiter({ windowMs: 60_000, max: 1 }))
    const { req, res, next } = buildReqRes('9.9.9.3')

    middleware(req, res, next)
    middleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(429)
    expect(next).toHaveBeenCalledTimes(1)

    enabled = false
    middleware(req, res, next)
    expect(next).toHaveBeenCalledTimes(2)
  })
})

describe('createRateLimiter — memory', () => {
  it('drops expired windows: thousands of one-off IPs do not stay in memory forever', () => {
    vi.useFakeTimers()
    try {
      const rateLimit = createRateLimiter({ windowMs: 60_000, max: 5 })
      for (let i = 0; i < 5_000; i++) {
        const { req, res, next } = buildReqRes(`2001:db8::${i.toString(16)}`)
        rateLimit(req, res, next)
      }
      expect(rateLimit.trackedKeyCount()).toBe(5_000)

      vi.advanceTimersByTime(60_001)
      const later = buildReqRes('203.0.113.7')
      rateLimit(later.req, later.res, later.next)

      expect(rateLimit.trackedKeyCount()).toBe(1)
      expect(later.next).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the sweep never forgets an IP whose window is still open (a blocked IP stays blocked)', () => {
    vi.useFakeTimers()
    try {
      const rateLimit = createRateLimiter({ windowMs: 60_000, max: 1 })
      const abuser = buildReqRes('198.51.100.1')
      rateLimit(abuser.req, abuser.res, abuser.next) // allowed, window opens

      vi.advanceTimersByTime(30_000)
      const other = buildReqRes('198.51.100.2')
      rateLimit(other.req, other.res, other.next) // triggers a sweep mid-window
      rateLimit(abuser.req, abuser.res, abuser.next) // still inside its window → blocked

      expect(abuser.next).toHaveBeenCalledTimes(1)
      expect(abuser.res.status).toHaveBeenCalledWith(429)
    } finally {
      vi.useRealTimers()
    }
  })
})
