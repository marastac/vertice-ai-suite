import { describe, expect, it, vi } from 'vitest'
import { createRateLimiter } from '../src/lib/rate-limit.js'

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
