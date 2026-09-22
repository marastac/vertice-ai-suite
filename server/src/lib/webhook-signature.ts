import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes -> 64 hex chars (256 bits). Node's crypto, nothing new. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Signs the exact bytes that will be sent as the request body — the caller
 * must pass the same string it sends over the wire, not a re-serialization
 * of the payload object, or the signature the receiver computes over the
 * bytes it actually received won't match.
 */
export function signWebhookPayload(secret: string, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  return `sha256=${digest}`
}

/** Constant-time comparison — for the (currently unused, but here for the future /test verification path or a receiving example) case of verifying a signature rather than only producing one. */
export function verifyWebhookSignature(secret: string, rawBody: string, signatureHeader: string): boolean {
  const expected = signWebhookPayload(secret, rawBody)
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(signatureHeader)
  if (expectedBuffer.length !== actualBuffer.length) return false
  return timingSafeEqual(expectedBuffer, actualBuffer)
}
