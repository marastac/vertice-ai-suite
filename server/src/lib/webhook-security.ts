import { BlockList, isIP } from 'node:net'
import dns from 'node:dns/promises'

/**
 * SSRF protection for outbound webhook deliveries, built entirely from
 * Node's own `node:net`/`node:dns` — no new dependency.
 *
 * Why `net.BlockList` instead of hand-rolled CIDR math: this project could
 * have written its own IPv4 integer/bitmask comparison easily enough, but
 * IPv6 range checking (link-local, unique-local, IPv4-mapped addresses,
 * zone ids like `fe80::1%eth0`) is easy to get subtly wrong by hand.
 * `net.BlockList` is a built-in, purpose-made-for-this-exact-problem API
 * (stable since Node 15) that correctly parses and matches both families —
 * using it is safer than a custom implementation, and it costs zero new
 * dependencies since it's core Node.
 *
 * Why resolution happens twice (once when saving a URL, once again
 * immediately before every delivery attempt — see resolveSafeConnectTarget,
 * called from webhook-delivery-service.ts): validating the URL at save
 * time is a UX nicety (reject obviously-bad URLs early), never the actual
 * security boundary. The boundary is: resolve DNS immediately before
 * connecting, reject if ANY resolved address is unsafe, and then pin the
 * real TCP/TLS connection to that exact validated address (see
 * webhook-delivery-service.ts's use of `lookup`) — never let a second,
 * independent DNS lookup happen for the real connection, or an attacker
 * controlling DNS could change the answer between the check and the
 * connection ("DNS rebinding") and slip a private-IP connection through a
 * hostname that looked public at save time.
 */

const blockList = new BlockList()

// IPv4: loopback, RFC1918 private ranges, link-local (this also covers the
// AWS/GCP/Azure metadata endpoint 169.254.169.254), CGNAT, documentation/
// test ranges, multicast, and the rest of the reserved space.
blockList.addSubnet('0.0.0.0', 8, 'ipv4') // "this network"
blockList.addSubnet('10.0.0.0', 8, 'ipv4')
blockList.addSubnet('100.64.0.0', 10, 'ipv4') // carrier-grade NAT
blockList.addSubnet('127.0.0.0', 8, 'ipv4') // loopback
blockList.addSubnet('169.254.0.0', 16, 'ipv4') // link-local incl. cloud metadata
blockList.addSubnet('172.16.0.0', 12, 'ipv4')
blockList.addSubnet('192.0.0.0', 24, 'ipv4') // IETF protocol assignments
blockList.addSubnet('192.0.2.0', 24, 'ipv4') // TEST-NET-1
blockList.addSubnet('192.168.0.0', 16, 'ipv4')
blockList.addSubnet('198.18.0.0', 15, 'ipv4') // benchmarking
blockList.addSubnet('198.51.100.0', 24, 'ipv4') // TEST-NET-2
blockList.addSubnet('203.0.113.0', 24, 'ipv4') // TEST-NET-3
blockList.addSubnet('224.0.0.0', 4, 'ipv4') // multicast
blockList.addSubnet('240.0.0.0', 4, 'ipv4') // reserved
blockList.addAddress('255.255.255.255', 'ipv4') // broadcast

// IPv6: loopback, unspecified, unique-local ("private" for v6), link-local,
// multicast, documentation range, and NAT64.
//
// Deliberately NO explicit ::ffff:0:0/96 (IPv4-mapped) rule here — this was
// tried and reverted during implementation. `net.BlockList` already cross-
// checks an IPv4-mapped IPv6 address (e.g. ::ffff:127.0.0.1) against the
// IPv4 rules above automatically (verified directly: `blockList.check('::ffff:127.0.0.1',
// 'ipv6')` matches the plain `127.0.0.0/8` IPv4 rule with no IPv6 rule
// needed for it at all). Adding an explicit ::ffff:0:0/96 IPv6 subnet on
// top of that is not just redundant, it's actively wrong: it made
// `blockList.check('8.8.8.8', 'ipv4')` — an ordinary, fully public IPv4
// address, checked as IPv4 — return `true` (blocked), because BlockList's
// cross-family matching runs in both directions: it was also comparing the
// IPv4 check against that IPv6 rule via 8.8.8.8's own IPv4-mapped form,
// and ::ffff:0:0/96 covers literally every IPv4-mapped address, so it
// matched every possible IPv4 input. This was caught by
// test/webhook-security.test.ts's "accepts a public IPv4 address" case —
// exactly the kind of bug a unit test here is for.
blockList.addSubnet('::1', 128, 'ipv6') // loopback
blockList.addSubnet('::', 128, 'ipv6') // unspecified
blockList.addSubnet('fe80::', 10, 'ipv6') // link-local
blockList.addSubnet('fc00::', 7, 'ipv6') // unique local (private)
blockList.addSubnet('ff00::', 8, 'ipv6') // multicast
blockList.addSubnet('2001:db8::', 32, 'ipv6') // documentation
blockList.addSubnet('64:ff9b::', 96, 'ipv6') // NAT64

export interface UrlFormatOk {
  ok: true
  url: URL
}
export interface UrlFormatError {
  ok: false
  reason: string
}

/**
 * Shape-only validation (no network access) — used when saving a
 * configuration, to reject obviously-invalid URLs immediately with a
 * clear message. Does NOT resolve DNS and is NOT the SSRF boundary; see
 * resolveSafeConnectTarget for that.
 */
export function validateWebhookUrlFormat(rawUrl: string): UrlFormatOk | UrlFormatError {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'La URL no es válida.' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'La URL debe usar HTTPS.' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'La URL no puede incluir usuario o contraseña.' }
  }
  if (!url.hostname) {
    return { ok: false, reason: 'La URL no tiene un dominio válido.' }
  }
  // A bare IP literal is allowed to pass format validation — it gets
  // checked directly (no DNS needed) by resolveSafeConnectTarget below,
  // same as any other candidate address.

  return { ok: true, url }
}

export interface SafeConnectTarget {
  address: string
  family: 4 | 6
}

export interface ResolveOk {
  ok: true
  target: SafeConnectTarget
}
export interface ResolveError {
  ok: false
  reason: string
}

function familyOf(n: number): 4 | 6 {
  return n === 6 ? 6 : 4
}

/**
 * Resolves `hostname` and rejects if ANY candidate address (not just the
 * first) falls in a private/reserved/loopback/link-local/unspecified
 * range. Fails closed: a hostname that doesn't resolve, or that this
 * function can't confidently classify, is treated as unsafe rather than
 * allowed through.
 *
 * Called twice per delivery lifecycle by design — once (informationally)
 * when a config is saved, and again immediately before every real HTTP
 * attempt in webhook-delivery-service.ts, which is the call that actually
 * matters: its result is what gets pinned to the outgoing connection.
 */
export async function resolveSafeConnectTarget(hostname: string): Promise<ResolveOk | ResolveError> {
  const literalFamily = isIP(hostname)

  let candidates: { address: string; family: number }[]
  if (literalFamily !== 0) {
    candidates = [{ address: hostname, family: literalFamily }]
  } else {
    try {
      candidates = await dns.lookup(hostname, { all: true, verbatim: true })
    } catch {
      return { ok: false, reason: 'No se pudo resolver el dominio de la URL.' }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: 'El dominio no resolvió a ninguna dirección IP.' }
  }

  for (const candidate of candidates) {
    const family = familyOf(candidate.family)
    if (blockList.check(candidate.address, family === 4 ? 'ipv4' : 'ipv6')) {
      return { ok: false, reason: 'La URL resuelve a una dirección IP privada o reservada.' }
    }
  }

  const chosen = candidates[0]
  return { ok: true, target: { address: chosen.address, family: familyOf(chosen.family) } }
}

/**
 * Combines the two checks above — used by the "save configuration"
 * endpoint so an obviously-unusable URL (wrong scheme, embedded
 * credentials, resolves to a private IP right now) is rejected up front.
 * This is a UX convenience, not a substitute for the per-delivery
 * resolveSafeConnectTarget() call webhook-delivery-service.ts always makes
 * regardless of what happened at save time.
 */
export async function validateWebhookUrlForSaving(rawUrl: string): Promise<UrlFormatOk | UrlFormatError> {
  const formatResult = validateWebhookUrlFormat(rawUrl)
  if (!formatResult.ok) return formatResult

  const resolveResult = await resolveSafeConnectTarget(formatResult.url.hostname)
  if (!resolveResult.ok) return { ok: false, reason: resolveResult.reason }

  return formatResult
}

/**
 * Residual limitations, documented rather than silently accepted:
 *  - This closes DNS-rebinding for the single connection each delivery
 *    attempt makes (resolve -> validate -> pin), but a destination that
 *    passes validation is still free to redirect (rejected, see
 *    webhook-delivery-service.ts — redirects are never followed) or to
 *    return arbitrary response content; neither is an SSRF concern once
 *    the connection itself was safe to open.
 *  - IPv6 zone ids (e.g. `fe80::1%eth0`) are not stripped before checking;
 *    Node's own `net.isIP`/`dns.lookup` already reject malformed literals
 *    containing a zone id in this context, so this hasn't needed explicit
 *    handling — worth revisiting if that ever changes.
 *  - This does not attempt to detect or block onward redirects/proxying
 *    performed by the destination server itself after a safe connection
 *    is established — that is the destination's own infrastructure, not
 *    a request this backend is making.
 */
