import { config } from '../config.js'
import { logger as defaultLogger } from '../lib/logger.js'
import { quotaRepository } from '../repositories/quota-repository.js'
import type { QuotaRepository } from '../repositories/quota-repository.js'

/**
 * Periodically closes abandoned quota reservations — those left 'reserved'
 * because the process died between reserving and settling (Railway
 * restart/SIGKILL) or both settlement attempts failed. All of the logic is
 * the atomic SQL function expire_stale_chat_reservations(); this only calls
 * it on a timer and logs the outcome. Same shape as webhook-worker.ts.
 *
 * Safe by construction:
 *   - Never frees anything: the database closes each one at its full
 *     estimate (settlement_basis 'expired'), which doesn't change the
 *     organization's remaining budget.
 *   - Stateless and idempotent: a restart, a missed tick, or two backend
 *     instances running this at once never double-counts (row locks +
 *     SKIP LOCKED in the database).
 *   - Only runs while CHAT_QUOTAS_ENABLED is on — with the flag off no
 *     reservation is ever created, so there is nothing to close.
 *   - Never throws: a failed tick is logged and retried on the next one.
 */

/** Off the visitor's critical path; 5 min + the 15-min expiry window closes a stale reservation in ~20 min. */
export const RECONCILE_INTERVAL_MS = 5 * 60_000

export interface QuotaReconcilerOptions {
  repository?: Pick<QuotaRepository, 'expireStale'>
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>
  isEnabled?: () => boolean
  intervalMs?: number
}

export interface QuotaReconciler {
  start(): void
  stop(): void
  /** One pass. Exposed for tests; never throws. Returns false when it was skipped (disabled or already running). */
  runOnce(): Promise<boolean>
}

export function createQuotaReconciler(options: QuotaReconcilerOptions = {}): QuotaReconciler {
  const repository = options.repository ?? quotaRepository
  const log = options.logger ?? defaultLogger
  const isEnabled = options.isEnabled ?? (() => config.chatQuotasEnabled)
  const intervalMs = options.intervalMs ?? RECONCILE_INTERVAL_MS

  let stopped = true
  let isRunning = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleNextTick(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void runOnce().finally(scheduleNextTick)
    }, intervalMs)
  }

  async function runOnce(): Promise<boolean> {
    // Never two passes at once in this process (a slow database must not
    // pile up overlapping sweeps).
    if (!isEnabled() || isRunning) return false
    isRunning = true
    try {
      const result = await repository.expireStale()
      if (!result.ok) {
        log.error('Quota reconciliation failed — will retry on the next pass', { kind: result.kind, message: result.message })
        return true
      }
      const data = result.data
      if (data.expiredCount > 0) {
        // Each one is a message whose process died or whose settlement
        // failed: worth seeing in the logs, even though it's handled.
        log.warn('Quota reconciliation closed abandoned reservations at their full estimate', { ...data })
      }
      if (data.organizationsFailed > 0) {
        log.error('Quota reconciliation could not process some organizations — see Postgres warnings', { ...data })
      }
      return true
    } catch (error) {
      // The repository contract is "never throws"; this is a second net so a
      // broken contract can never kill the timer loop.
      log.error('Quota reconciliation pass threw unexpectedly', { message: error instanceof Error ? error.message : String(error) })
      return true
    } finally {
      isRunning = false
    }
  }

  return {
    start() {
      if (!isEnabled()) {
        log.info('Quota reconciler not started — CHAT_QUOTAS_ENABLED is off.')
        return
      }
      if (!stopped) return
      stopped = false
      scheduleNextTick()
      log.info('Quota reconciler started.')
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    runOnce,
  }
}

const reconciler = createQuotaReconciler()

/** Called after app.listen() (see index.ts) — never delays the server start. */
export function startQuotaReconciler(): void {
  reconciler.start()
}

/** Called on SIGTERM/SIGINT so a Railway restart doesn't leave the timer dangling. */
export function stopQuotaReconciler(): void {
  reconciler.stop()
}
