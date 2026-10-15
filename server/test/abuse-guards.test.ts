import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimiter } from '../src/lib/rate-limit.js'

// Public-chat abuse protection (Fase 4): configuration parsing of
// CHAT_ABUSE_GUARDS / CHAT_GLOBAL_MAX_MESSAGES_PER_MINUTE and the global
// (constant-key) limiter. No network, no Anthropic.

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return (await import('../src/config.js')).config
}

afterEach(() => {
  delete process.env.CHAT_ABUSE_GUARDS
  delete process.env.CHAT_GLOBAL_MAX_MESSAGES_PER_MINUTE
})

describe('CHAT_ABUSE_GUARDS', () => {
  it('is ON when unset, empty, garbage or "on" — only an explicit "off" disables it', async () => {
    for (const value of [undefined, '', 'on', 'true', 'false', '0', 'nope']) {
      expect((await loadConfig({ CHAT_ABUSE_GUARDS: value })).chatAbuseGuardsEnabled, String(value)).toBe(true)
    }
    for (const value of ['off', 'OFF', ' Off ']) {
      expect((await loadConfig({ CHAT_ABUSE_GUARDS: value })).chatAbuseGuardsEnabled, value).toBe(false)
    }
  })
})

describe('CHAT_GLOBAL_MAX_MESSAGES_PER_MINUTE', () => {
  it('is off (0) unless a positive number; decimals are floored', async () => {
    for (const value of [undefined, '', '0', '-5', 'abc']) {
      expect((await loadConfig({ CHAT_GLOBAL_MAX_MESSAGES_PER_MINUTE: value })).chatGlobalMaxMessagesPerMinute, String(value)).toBe(0)
    }
    expect((await loadConfig({ CHAT_GLOBAL_MAX_MESSAGES_PER_MINUTE: '120' })).chatGlobalMaxMessagesPerMinute).toBe(120)
    expect((await loadConfig({ CHAT_GLOBAL_MAX_MESSAGES_PER_MINUTE: '7.9' })).chatGlobalMaxMessagesPerMinute).toBe(7)
  })
})

function reqRes(ip: string) {
  const req = { ip } as never
  const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
  const next = vi.fn()
  return { req, res: res as never as Parameters<ReturnType<typeof createRateLimiter>>[1], rawRes: res, next }
}

describe('global limiter (constant key)', () => {
  it('counts every visitor together: many IPs share one budget per window', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, key: () => 'global', message: 'ocupado' })
    const calls = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'].map((ip) => {
      const r = reqRes(ip)
      limiter(r.req, r.res, r.next)
      return r
    })
    expect(calls.filter((c) => c.next.mock.calls.length === 1)).toHaveLength(3)
    expect(calls[3].rawRes.status).toHaveBeenCalledWith(429)
    expect(calls[4].rawRes.json).toHaveBeenCalledWith({ error: 'ocupado' })
  })

  it('a repeated burst from ONE IP is cut by the per-IP limiter long before it reaches the global one', () => {
    const perIp = createRateLimiter({ windowMs: 5 * 60_000, max: 40 })
    const global = createRateLimiter({ windowMs: 60_000, max: 1000, key: () => 'global' })
    let reachedGlobal = 0
    for (let i = 0; i < 500; i++) {
      const r = reqRes('203.0.113.9')
      perIp(r.req, r.res, () => {
        const g = reqRes('203.0.113.9')
        global(g.req, g.res, () => (reachedGlobal += 1))
      })
    }
    expect(reachedGlobal).toBe(40)
  })
})
