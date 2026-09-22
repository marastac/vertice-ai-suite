import { describe, expect, it } from 'vitest'
import { resolveSafeConnectTarget, validateWebhookUrlFormat } from '../src/lib/webhook-security.js'

describe('validateWebhookUrlFormat', () => {
  it('accepts a well-formed https URL', () => {
    const result = validateWebhookUrlFormat('https://example.com/hook')
    expect(result.ok).toBe(true)
  })

  it('rejects http (non-https)', () => {
    const result = validateWebhookUrlFormat('http://example.com/hook')
    expect(result.ok).toBe(false)
  })

  it('rejects an unparseable URL', () => {
    const result = validateWebhookUrlFormat('not a url')
    expect(result.ok).toBe(false)
  })

  it('rejects embedded credentials', () => {
    const result = validateWebhookUrlFormat('https://user:pass@example.com/hook')
    expect(result.ok).toBe(false)
  })
})

// Uses IP literals (not real hostnames) so these run deterministically with
// no network access — resolveSafeConnectTarget() skips DNS entirely for an
// address that's already a literal (see its use of net.isIP()), so this
// exercises the exact same BlockList checks a resolved hostname would go
// through, without depending on DNS being reachable in CI/sandboxed
// environments.
describe('resolveSafeConnectTarget', () => {
  it('rejects IPv4 loopback', async () => {
    const result = await resolveSafeConnectTarget('127.0.0.1')
    expect(result.ok).toBe(false)
  })

  it('rejects IPv4 private ranges (RFC1918)', async () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '192.168.1.1']) {
      const result = await resolveSafeConnectTarget(ip)
      expect(result.ok, `${ip} should be rejected`).toBe(false)
    }
  })

  it('rejects the link-local range, including the cloud metadata address', () => {
    return resolveSafeConnectTarget('169.254.169.254').then((result) => {
      expect(result.ok).toBe(false)
    })
  })

  it('rejects IPv4 unspecified/broadcast/reserved', async () => {
    for (const ip of ['0.0.0.0', '255.255.255.255', '240.0.0.1']) {
      const result = await resolveSafeConnectTarget(ip)
      expect(result.ok, `${ip} should be rejected`).toBe(false)
    }
  })

  it('rejects IPv6 loopback, unspecified, unique-local, and link-local', async () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fe80::1']) {
      const result = await resolveSafeConnectTarget(ip)
      expect(result.ok, `${ip} should be rejected`).toBe(false)
    }
  })

  it('rejects an IPv4-mapped IPv6 loopback address (a known SSRF-filter bypass trick)', async () => {
    const result = await resolveSafeConnectTarget('::ffff:127.0.0.1')
    expect(result.ok).toBe(false)
  })

  it('accepts a public IPv4 address and pins the exact resolved address/family', async () => {
    const result = await resolveSafeConnectTarget('8.8.8.8')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.target.address).toBe('8.8.8.8')
      expect(result.target.family).toBe(4)
    }
  })
})
