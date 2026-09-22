import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { webhookRepository } from '../repositories/webhook-repository.js'
import type { WebhookDeliveryRow } from '../repositories/webhook-repository.js'
import { attemptWebhookDelivery } from './webhook-delivery-service.js'

const POLL_INTERVAL_MS = 5_000
const BATCH_SIZE = 10
const LEASE_SECONDS = 120
const CONCURRENCY = 3
// After attempt 1, 2, 3, 4 fail. Attempt 5 (the last one MAX_ATTEMPTS
// allows) failing marks the delivery permanently 'failed' — no 5th entry
// needed since there's no attempt 6.
export const BACKOFF_SCHEDULE_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]
export const MAX_ATTEMPTS = 5

/** Pure — how long to wait before the next retry, given this was attempt number `attempts` (1-indexed, matching claim_webhook_deliveries()'s already-incremented value). Exported separately from processDelivery() so it's testable without mocking the repository/network. */
export function computeBackoffMs(attempts: number): number {
  return BACKOFF_SCHEDULE_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_SCHEDULE_MS.length - 1)]
}

/** Pure — true once no further retry should be scheduled. */
export function hasExhaustedAttempts(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS
}

// Simple, deliberately generous abuse guard — see the audit's "riesgo de
// spam/costo" note. Enforced here, in the worker, not in the `leads`
// trigger: the trigger must never be able to fail or skip enqueueing over
// volume (that would risk the lead INSERT itself), so rate limiting lives
// entirely in the delivery path, which can safely defer a delivery without
// touching `leads` at all. A deferred delivery is NOT counted as a failed
// attempt (attempts is not incremented further here) — it simply waits.
const ORG_HOURLY_DELIVERY_LIMIT = 100
const RATE_LIMIT_DEFER_MS = 10 * 60_000

let stopped = true
let isRunning = false
let timer: ReturnType<typeof setTimeout> | null = null

/** Never blocks/delays Express from starting — see index.ts, this is called after app.listen(), not before it. No-ops (with a log line) if Webhooks isn't configured, exactly like the rest of the feature. */
export function startWebhookWorker(): void {
  if (!config.isWebhooksConfigured) {
    logger.info('Webhook worker not started — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set.')
    return
  }
  stopped = false
  scheduleNextTick()
  logger.info('Webhook worker started.')
}

/** Called on SIGTERM/SIGINT (see index.ts) so a Railway restart/redeploy doesn't leave the process's own timer dangling — the in-flight batch (if any) still finishes; this only stops scheduling new ticks. */
export function stopWebhookWorker(): void {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function scheduleNextTick(): void {
  if (stopped) return
  timer = setTimeout(() => {
    void runOnce()
  }, POLL_INTERVAL_MS)
}

async function runOnce(): Promise<void> {
  // Never run two ticks concurrently in this same process — a slow batch
  // (several deliveries stalling near the timeout at once) must not cause
  // overlapping polls against the same claim.
  if (isRunning) {
    scheduleNextTick()
    return
  }

  isRunning = true
  try {
    const claimed = await webhookRepository.claimDeliveries(BATCH_SIZE, LEASE_SECONDS)
    if (claimed.length > 0) {
      await processBatch(claimed)
    }
  } catch (error) {
    logger.error('Webhook worker tick failed', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    isRunning = false
    scheduleNextTick()
  }
}

/** Small fixed-size worker pool — bounds how many deliveries are in flight at once without pulling in a queue library for what's a handful of concurrent HTTPS requests. */
async function processBatch(deliveries: WebhookDeliveryRow[]): Promise<void> {
  let index = 0
  async function worker(): Promise<void> {
    while (index < deliveries.length) {
      const delivery = deliveries[index]
      index += 1
      await processDelivery(delivery)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, deliveries.length) }, () => worker()))
}

async function processDelivery(delivery: WebhookDeliveryRow): Promise<void> {
  try {
    const recentCount = await webhookRepository.countRecentDeliveriesForOrganization(
      delivery.organization_id,
      new Date(Date.now() - 60 * 60_000).toISOString(),
    )
    if (recentCount > ORG_HOURLY_DELIVERY_LIMIT) {
      await webhookRepository.markRetry(delivery.id, {
        nextAttemptAt: new Date(Date.now() + RATE_LIMIT_DEFER_MS).toISOString(),
        lastError: 'rate_limited',
        responseStatus: null,
      })
      return
    }

    // webhook_configuration_id is ON DELETE SET NULL (see
    // migrations-webhooks.sql) — the organization may have deleted its
    // webhook configuration after this delivery was enqueued (or even
    // while it sat 'processing' under a lease from a crashed worker). A
    // null id here means there is no configuration left to resolve a URL/
    // secret from, ever, for this row again — that's a deterministic
    // terminal state, not a transient failure, so it's marked 'failed'
    // once and never retried, with no lookup call attempted at all (a
    // `getConfigById(null)` call would be meaningless).
    if (delivery.webhook_configuration_id === null) {
      await webhookRepository.markFailedPermanently(delivery.id, {
        lastError: 'webhook_config_deleted',
        responseStatus: null,
      })
      return
    }

    const webhookConfig = await webhookRepository.getConfigById(delivery.webhook_configuration_id)
    if (!webhookConfig || !webhookConfig.is_active) {
      // The organization turned the webhook off (or deleted it) between
      // enqueue and delivery — nothing to retry toward.
      await webhookRepository.markFailedPermanently(delivery.id, { lastError: 'webhook_inactive', responseStatus: null })
      return
    }

    const rawBody = JSON.stringify(delivery.payload)
    const result = await attemptWebhookDelivery({
      url: webhookConfig.url,
      secret: webhookConfig.secret,
      eventType: delivery.event_type,
      deliveryId: delivery.id,
      rawBody,
    })

    if (result.outcome === 'delivered') {
      await webhookRepository.markDelivered(delivery.id, result.responseStatus)
      return
    }

    if (hasExhaustedAttempts(delivery.attempts)) {
      await webhookRepository.markFailedPermanently(delivery.id, {
        lastError: result.errorReason ?? 'unknown_error',
        responseStatus: result.responseStatus,
      })
      return
    }

    const backoffMs = computeBackoffMs(delivery.attempts)
    await webhookRepository.markRetry(delivery.id, {
      nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
      lastError: result.errorReason ?? 'unknown_error',
      responseStatus: result.responseStatus,
    })
  } catch (error) {
    // A failure here means the repository update itself failed (e.g. a
    // transient Supabase error) — the row is left in 'processing' and will
    // be reclaimed automatically once its lease (locked_at) expires, per
    // claim_webhook_deliveries()'s own recovery logic. Nothing to do here
    // but log and move on.
    logger.error('Webhook delivery processing failed', {
      deliveryId: delivery.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
