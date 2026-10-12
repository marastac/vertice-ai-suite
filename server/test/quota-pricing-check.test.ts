import { describe, expect, it, vi } from 'vitest'
import type { QuotaRpcResult } from '../src/repositories/quota-repository.js'
import { checkQuotaPricingAtStartup } from '../src/services/quota-pricing-check.js'

// The startup check only READS whether model_prices has the configured
// model. It must be loud when the price is missing, quiet otherwise, and
// never throw, block startup, call Anthropic or log any price.

function setup(options: { enabled?: boolean; result?: QuotaRpcResult<boolean> | (() => Promise<QuotaRpcResult<boolean>>) } = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const result = options.result ?? { ok: true as const, data: true }
  const hasModelPrice = vi.fn(typeof result === 'function' ? result : async () => result)
  const run = () =>
    checkQuotaPricingAtStartup({
      repository: { hasModelPrice },
      logger,
      isEnabled: () => options.enabled ?? true,
      model: () => 'claude-test-model',
    })
  return { run, hasModelPrice, logger }
}

describe('quota pricing check at startup', () => {
  it('does nothing at all while CHAT_QUOTAS_ENABLED is off', async () => {
    const { run, hasModelPrice, logger } = setup({ enabled: false })

    await expect(run()).resolves.toBe('skipped')
    expect(hasModelPrice).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('price present → configured, info only', async () => {
    const { run, hasModelPrice, logger } = setup({ result: { ok: true, data: true } })

    await expect(run()).resolves.toBe('configured')
    expect(hasModelPrice).toHaveBeenCalledWith('claude-test-model')
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), { model: 'claude-test-model' })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('price MISSING → a loud error naming the model (and nothing else)', async () => {
    const { run, logger } = setup({ result: { ok: true, data: false } })

    await expect(run()).resolves.toBe('missing')
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('NO price'), { model: 'claude-test-model' })
  })

  it('database unavailable → warning, startup unaffected', async () => {
    const { run, logger } = setup({ result: { ok: false, kind: 'transient', message: 'down' } })

    await expect(run()).resolves.toBe('unverified')
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ model: 'claude-test-model', kind: 'transient' }))
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('never throws, even if the repository breaks its own contract', async () => {
    const { run, logger } = setup({
      result: async () => {
        throw new Error('contract broken')
      },
    })

    await expect(run()).resolves.toBe('unverified')
    expect(logger.warn).toHaveBeenCalled()
  })
})
