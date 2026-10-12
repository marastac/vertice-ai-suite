import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExpireResult, QuotaRpcResult } from '../src/repositories/quota-repository.js'
import { createQuotaReconciler } from '../src/services/quota-reconciler.js'

// The reconciler only calls the atomic SQL function on a timer and logs the
// outcome — its correctness (never free, atomic, idempotent, SKIP LOCKED)
// lives in Postgres and is covered by supabase/tests-usage-quotas.sql.
// These tests prove the JOB itself is safe: gated by the flag, never
// overlapping, never throwing, and visible in the logs.

afterEach(() => {
  vi.useRealTimers()
})

const NOTHING: ExpireResult = {
  expiredCount: 0,
  expiredMicros: 0,
  organizationsProcessed: 0,
  organizationsSkippedLocked: 0,
  organizationsFailed: 0,
}

function setup(options: { enabled?: boolean; result?: QuotaRpcResult<ExpireResult> | (() => Promise<QuotaRpcResult<ExpireResult>>) } = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const result = options.result ?? { ok: true as const, data: NOTHING }
  const expireStale = vi.fn(typeof result === 'function' ? result : async () => result)
  const reconciler = createQuotaReconciler({
    repository: { expireStale },
    logger,
    isEnabled: () => options.enabled ?? true,
    intervalMs: 1_000,
  })
  return { reconciler, expireStale, logger }
}

describe('quota reconciler', () => {
  it('does nothing at all while CHAT_QUOTAS_ENABLED is off (no timer, no database call)', async () => {
    vi.useFakeTimers()
    const { reconciler, expireStale, logger } = setup({ enabled: false })

    reconciler.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await reconciler.runOnce()).toBe(false)

    expect(expireStale).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not started'))
  })

  it('runs one pass per interval once started, and stops scheduling after stop()', async () => {
    vi.useFakeTimers()
    const { reconciler, expireStale } = setup()

    reconciler.start()
    expect(expireStale).not.toHaveBeenCalled() // never at boot: never delays startup
    await vi.advanceTimersByTimeAsync(1_000)
    expect(expireStale).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(expireStale).toHaveBeenCalledTimes(2)

    reconciler.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(expireStale).toHaveBeenCalledTimes(2)
  })

  it('calling start() twice does not create a second timer', async () => {
    vi.useFakeTimers()
    const { reconciler, expireStale } = setup()

    reconciler.start()
    reconciler.start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(expireStale).toHaveBeenCalledTimes(1)
    reconciler.stop()
  })

  it('never runs two passes at once in the same process', async () => {
    let release: (value: QuotaRpcResult<ExpireResult>) => void = () => {}
    const { reconciler, expireStale } = setup()
    // Only the FIRST pass hangs until released; later passes resolve normally.
    expireStale.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))

    const first = reconciler.runOnce()
    expect(await reconciler.runOnce()).toBe(false) // second call while the first is in flight
    release({ ok: true, data: NOTHING })
    await first

    expect(expireStale).toHaveBeenCalledTimes(1)
    expect(await reconciler.runOnce()).toBe(true) // free again afterwards
    expect(expireStale).toHaveBeenCalledTimes(2)
  })

  it('logs a warning with the counts whenever reservations were expired', async () => {
    const data = { ...NOTHING, expiredCount: 2, expiredMicros: 3_000, organizationsProcessed: 1 }
    const { reconciler, logger } = setup({ result: { ok: true, data } })

    await reconciler.runOnce()

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('abandoned'), expect.objectContaining(data))
  })

  it('stays silent when there was nothing to expire', async () => {
    const { reconciler, logger } = setup()

    await reconciler.runOnce()

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports organizations the database could not process', async () => {
    const { reconciler, logger } = setup({ result: { ok: true, data: { ...NOTHING, organizationsFailed: 1 } } })

    await reconciler.runOnce()

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not process'), expect.objectContaining({ organizationsFailed: 1 }))
  })

  it('a failed pass (Supabase down) is logged, never thrown, and the next pass still runs', async () => {
    vi.useFakeTimers()
    const { reconciler, expireStale, logger } = setup({ result: { ok: false, kind: 'transient', message: 'down' } })

    reconciler.start()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(expireStale).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('retry'), expect.objectContaining({ kind: 'transient' }))
    reconciler.stop()
  })

  it('a repository that breaks its "never throws" contract still cannot kill the loop', async () => {
    vi.useFakeTimers()
    const { reconciler, expireStale, logger } = setup({
      result: async () => {
        throw new Error('contract broken')
      },
    })

    reconciler.start()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(expireStale).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('threw'), { message: 'contract broken' })
    reconciler.stop()
  })
})
