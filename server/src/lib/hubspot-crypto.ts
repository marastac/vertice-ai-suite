import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Application-level encryption for HubSpot OAuth tokens at rest —
 * webhook_configurations.secret (see webhook-signature.ts) sits behind RLS
 * alone, but a live HubSpot access/refresh token is a bearer credential
 * into the customer's own external CRM (broader blast radius, and unlike a
 * webhook secret, not something the customer can rotate from within Lead
 * AI if it leaks — see the HubSpot integration audit for the full
 * reasoning). AES-256-GCM via node:crypto only — zero new dependencies,
 * same posture as webhook-security.ts's use of net.BlockList.
 *
 * This module is deliberately pure and key-agnostic: it never reads
 * config/env itself (mirrors webhook-signature.ts's signWebhookPayload(),
 * which takes `secret` as an explicit parameter rather than importing a
 * singleton) — callers pass the key in. That keeps this file fully
 * testable with fabricated keys and keeps the one real encryption key
 * (HUBSPOT_TOKEN_ENCRYPTION_KEY) owned by config.ts alone.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32 // AES-256
const IV_BYTES = 12 // GCM's standard/recommended nonce length
const AUTH_TAG_BYTES = 16
/** Bump this if the stored format ever needs to change — decryptHubspotToken() rejects anything else outright rather than guessing. */
const FORMAT_VERSION = 'v1'

/**
 * Parses HUBSPOT_TOKEN_ENCRYPTION_KEY (expected: base64 encoding of
 * exactly 32 random bytes, e.g. generated once via
 * `crypto.randomBytes(32).toString('base64')`) into a usable key buffer.
 *
 * Returns `undefined` — never throws — for both "unset" and "set but
 * malformed" (wrong decoded length). Both cases are treated identically by
 * config.ts: HubSpot stays reported as unconfigured rather than crashing
 * the process, exactly like every other optional backend feature in this
 * project (ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY). The caller
 * (config.ts) is responsible for logging a warning when the raw value was
 * present but this returned `undefined` — this function itself never
 * logs anything, and never includes the raw value in its return path in a
 * way that could end up logged by accident.
 */
export function parseHubspotEncryptionKey(raw: string | undefined): Buffer | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined

  const key = Buffer.from(trimmed, 'base64')
  if (key.length !== KEY_BYTES) return undefined
  return key
}

function assertKeyLength(key: Buffer, callerName: string): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`${callerName}: key must be exactly ${KEY_BYTES} bytes (AES-256) — got ${key.length}.`)
  }
}

/**
 * Encrypts `plaintext` (an access or refresh token) with a fresh,
 * cryptographically random IV every call — even encrypting the exact same
 * token twice produces a different stored value, since GCM's security
 * depends on never reusing an (key, IV) pair. Returns a single versioned,
 * colon-delimited string — `v1:<iv b64>:<authTag b64>:<ciphertext b64>` —
 * safe to store directly in a text column
 * (hubspot_connections.access_token_encrypted / .refresh_token_encrypted).
 *
 * Never logs `plaintext` or `key` — and callers must not either.
 */
export function encryptHubspotToken(plaintext: string, key: Buffer): string {
  assertKeyLength(key, 'encryptHubspotToken')

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [FORMAT_VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

/**
 * Reverses encryptHubspotToken(). Fails closed on anything that isn't
 * exactly the expected format/lengths, and — the actual cryptographic
 * integrity check — on a ciphertext or authentication tag that doesn't
 * match (tampering, corruption, or the wrong key entirely): GCM
 * authentication failure surfaces as decipher.final() throwing, which
 * this always converts into the same generic error rather than letting
 * Node's own error (which can vary by engine/version) leak outward.
 *
 * Never logs `stored`, `key`, or the recovered plaintext.
 */
export function decryptHubspotToken(stored: string, key: Buffer): string {
  assertKeyLength(key, 'decryptHubspotToken')

  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error('decryptHubspotToken: unrecognized ciphertext format.')
  }
  const [, ivB64, authTagB64, ciphertextB64] = parts

  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  // Length checks first — cheap, deterministic, and catch obviously
  // truncated/malformed input before ever touching the decipher. Buffer.from(...,
  // 'base64') itself never throws on invalid characters (it decodes
  // leniently), so these explicit checks are the real gate here, not a
  // try/catch around the decoding.
  if (iv.length !== IV_BYTES) {
    throw new Error('decryptHubspotToken: invalid IV length.')
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('decryptHubspotToken: invalid authentication tag length.')
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch {
    throw new Error('decryptHubspotToken: authentication failed — ciphertext or tag is invalid or has been tampered with.')
  }
}
