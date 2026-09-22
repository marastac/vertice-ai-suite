import https from 'node:https'
import { resolveSafeConnectTarget } from '../lib/webhook-security.js'
import { signWebhookPayload } from '../lib/webhook-signature.js'

const REQUEST_TIMEOUT_MS = 8_000
// We never need the destination's response body — only its status code —
// so this just bounds how much we'll read off the socket before giving up
// on it, defensively, rather than being an intentional "read the body"
// budget.
const MAX_RESPONSE_BYTES = 64 * 1024

export interface DeliveryAttemptParams {
  url: string
  secret: string
  eventType: string
  deliveryId: string
  /** Must be the exact string that gets sent as the request body — signed and transmitted as the same bytes, never re-serialized separately. */
  rawBody: string
}

export interface DeliveryAttemptResult {
  outcome: 'delivered' | 'failed'
  responseStatus: number | null
  /** Short, sanitized reason code — never the destination's response body, never a raw Node error message (which can embed the resolved IP/hostname). Safe to persist in webhook_deliveries.last_error. */
  errorReason: string | null
}

// Derived structurally from https.RequestOptions itself (same reasoning as
// the doc comment on buildPinnedLookup below) rather than importing
// net.LookupFunction by name.
type PinnedLookup = NonNullable<https.RequestOptions['lookup']>

/**
 * Builds the `lookup` function passed to https.request() below, pinning
 * the connection to the exact address resolveSafeConnectTarget already
 * validated — see that function's doc comment for why this pinning is the
 * real SSRF/DNS-rebinding boundary.
 *
 * MUST branch on `options.all`: Node's own https.request()/net.connect()
 * invoke this callback with `options.all === true` (confirmed empirically
 * against a real HTTPS server, not just inferred from the dns.lookup()
 * docs), which means Node expects the dns.lookup(..., { all: true }, cb)
 * array contract — callback(err, [{ address, family }]) — not the single-
 * address callback(err, address, family) form. Calling back with the wrong
 * shape doesn't silently misbehave: Node throws ERR_INVALID_IP_ADDRESS
 * synchronously while opening the socket, which surfaced as the generic
 * 'network_error' below and broke every webhook delivery attempt — see
 * test/webhook-delivery-lookup.test.ts, which exercises this exact
 * function against a real local HTTP server specifically so this can't
 * regress unnoticed again. Extracted as its own named function (rather
 * than inline in the request options, where it lived when this bug was
 * first introduced) so that test can call it directly.
 */
export function buildPinnedLookup(address: string, family: 4 | 6): PinnedLookup {
  return (_hostname, options, callback) => {
    if (options && typeof options === 'object' && 'all' in options && options.all) {
      callback(null, [{ address, family }])
    } else {
      callback(null, address, family)
    }
  }
}

/**
 * Sends one signed POST to `params.url`. Only a 2xx status counts as
 * delivered; 3xx is treated as a failure without ever following the
 * redirect (the redirect target has not been through SSRF validation);
 * 4xx/5xx/timeouts/network errors are failures the caller (webhook-worker.ts)
 * may retry.
 *
 * Uses `node:https` directly rather than the global `fetch()` used
 * elsewhere in this backend (see ai-provider.ts) specifically because
 * `fetch()` offers no way to pin the TCP connection to a pre-validated IP
 * without also pulling in the `undici` package for its `Dispatcher`/`Agent`
 * API — https.request()'s built-in `lookup` option achieves the same
 * result with zero new dependencies. See webhook-security.ts's doc comment
 * for why that pinning matters (DNS rebinding).
 */
export async function attemptWebhookDelivery(params: DeliveryAttemptParams): Promise<DeliveryAttemptResult> {
  let target: URL
  try {
    target = new URL(params.url)
  } catch {
    return { outcome: 'failed', responseStatus: null, errorReason: 'invalid_url' }
  }
  if (target.protocol !== 'https:') {
    return { outcome: 'failed', responseStatus: null, errorReason: 'non_https_url' }
  }

  const resolved = await resolveSafeConnectTarget(target.hostname)
  if (!resolved.ok) {
    return { outcome: 'failed', responseStatus: null, errorReason: 'blocked_address' }
  }
  const { address, family } = resolved.target

  const signature = signWebhookPayload(params.secret, params.rawBody)
  const bodyBuffer = Buffer.from(params.rawBody, 'utf8')

  return new Promise((resolve) => {
    let settled = false
    const settle = (result: DeliveryAttemptResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const req = https.request(
      {
        hostname: target.hostname,
        servername: target.hostname, // correct TLS SNI/cert validation against the real domain, not the pinned IP
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        // See buildPinnedLookup's doc comment above for why this can't just
        // be `callback(null, address, family)` inline.
        lookup: buildPinnedLookup(address, family),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuffer.length,
          'X-LeadAI-Event': params.eventType,
          'X-LeadAI-Delivery': params.deliveryId,
          'X-LeadAI-Signature': signature,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > MAX_RESPONSE_BYTES) res.destroy()
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) {
            settle({ outcome: 'delivered', responseStatus: status, errorReason: null })
          } else if (status >= 300 && status < 400) {
            settle({ outcome: 'failed', responseStatus: status, errorReason: 'redirect_not_followed' })
          } else {
            settle({ outcome: 'failed', responseStatus: status, errorReason: `http_${status}` })
          }
        })
        res.on('error', () => {
          settle({ outcome: 'failed', responseStatus: res.statusCode ?? null, errorReason: 'response_stream_error' })
        })
      },
    )

    req.on('timeout', () => {
      req.destroy()
      settle({ outcome: 'failed', responseStatus: null, errorReason: 'timeout' })
    })

    // Deliberately not `error.message` — a raw Node network error can embed
    // the resolved IP/hostname/port, which we don't want sitting in
    // last_error indefinitely.
    req.on('error', () => {
      settle({ outcome: 'failed', responseStatus: null, errorReason: 'network_error' })
    })

    req.write(bodyBuffer)
    req.end()
  })
}
