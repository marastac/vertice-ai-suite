import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildPinnedLookup } from '../src/services/webhook-delivery-service.js'

// Regression coverage for a production incident: Node's own
// https.request()/http.request() (via node:net's socket-connect machinery)
// invoke a custom `lookup` function with `options.all === true` — the
// dns.lookup(..., { all: true }) "array of addresses" contract — not the
// single-address callback(err, address, family) form the original
// implementation always replied with. Getting this wrong doesn't degrade
// gracefully: Node throws ERR_INVALID_IP_ADDRESS synchronously while
// opening the socket, which surfaced to the app as a generic
// 'network_error' and silently broke every webhook delivery attempt
// (both the "Probar webhook" test button and every real lead.created
// delivery via the worker), with nothing logged anywhere.

describe('buildPinnedLookup', () => {
  it('replies with an array of {address, family} when called with options.all (dns.lookup "all" contract)', () => {
    const lookup = buildPinnedLookup('93.184.216.34', 4)
    const calls: unknown[][] = []
    lookup('irrelevant-hostname.example', { all: true }, (...args: unknown[]) => {
      calls.push(args)
    })
    expect(calls).toEqual([[null, [{ address: '93.184.216.34', family: 4 }]]])
  })

  it('replies with a single address/family pair when called without options.all', () => {
    const lookup = buildPinnedLookup('93.184.216.34', 4)
    const calls: unknown[][] = []
    lookup('irrelevant-hostname.example', { all: false }, (...args: unknown[]) => {
      calls.push(args)
    })
    expect(calls).toEqual([[null, '93.184.216.34', 4]])
  })
})

/**
 * The two unit tests above only prove buildPinnedLookup()'s own branching
 * is internally consistent — they would NOT have caught the original bug,
 * since that bug was about what Node's real request internals actually
 * call it with, not about our own logic being self-contradictory. This
 * test instead wires buildPinnedLookup() into a genuine http.request()
 * against a real local server, so it fails the exact same way production
 * did if this regresses.
 *
 * Uses plain `http`, not `https`, deliberately: the bug lived in
 * node:net's `emitLookup` (the socket-level connection/lookup machinery
 * shared by both http.Agent and https.Agent), not anything TLS-specific —
 * confirmed directly against a real public HTTPS server during the
 * incident audit, where the failure was identical. Testing over plain
 * HTTP against a local ephemeral server keeps this deterministic and
 * dependency-free (no self-signed certificate machinery) while still
 * exercising the exact code path that broke.
 *
 * Uses `hostname: 'localhost'` rather than the literal `'127.0.0.1'`
 * deliberately: Node skips calling a custom `lookup` entirely when the
 * hostname is already an IP literal (there is nothing to resolve), which
 * would make this test pass regardless of buildPinnedLookup's
 * correctness. A non-literal hostname is what forces Node through the
 * same custom-lookup path a real webhook URL's hostname goes through.
 */
describe('buildPinnedLookup wired into a real http.request()', () => {
  it('connects successfully when pinned to the server’s real address', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the test server to report an AddressInfo.')
    }

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: address.port,
            path: '/',
            method: 'GET',
            lookup: buildPinnedLookup('127.0.0.1', 4),
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        req.end()
      })

      expect(status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
