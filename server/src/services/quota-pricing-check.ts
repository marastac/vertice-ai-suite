import { config } from '../config.js'
import { logger as defaultLogger } from '../lib/logger.js'
import { quotaRepository } from '../repositories/quota-repository.js'
import type { QuotaRepository } from '../repositories/quota-repository.js'

/**
 * One-time check at startup: does model_prices have a price for the model
 * the chat calls Anthropic with (config.anthropicModel / ANTHROPIC_MODEL)?
 *
 * Without it, reserve_chat_usage() denies EVERY message of organizations in
 * 'enforce' ('model_price_missing') and records nothing for those in
 * 'shadow'. This makes that misconfiguration loud in the logs the moment the
 * backend starts, instead of being discovered from visitors' failed chats.
 *
 *   - Only runs while CHAT_QUOTAS_ENABLED is on (with it off, prices are
 *     never used).
 *   - Read-only; never calls Anthropic; never throws; never blocks or delays
 *     startup (called after app.listen(), not awaited). The per-request
 *     checks (session pre-check + reserve) remain the real enforcement.
 *   - Logs the model identifier only — never any price.
 */

export type PricingCheckResult = 'skipped' | 'configured' | 'missing' | 'unverified'

export interface PricingCheckOptions {
  repository?: Pick<QuotaRepository, 'hasModelPrice'>
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>
  isEnabled?: () => boolean
  model?: () => string
}

export async function checkQuotaPricingAtStartup(options: PricingCheckOptions = {}): Promise<PricingCheckResult> {
  const repository = options.repository ?? quotaRepository
  const log = options.logger ?? defaultLogger
  const isEnabled = options.isEnabled ?? (() => config.chatQuotasEnabled)
  const model = (options.model ?? (() => config.anthropicModel))()

  if (!isEnabled()) return 'skipped'

  try {
    const result = await repository.hasModelPrice(model)
    if (!result.ok) {
      log.warn('Quota pricing check could not verify the configured model price at startup', {
        model,
        kind: result.kind,
        message: result.message,
      })
      return 'unverified'
    }
    if (!result.data) {
      log.error(
        'Quota pricing: model_prices has NO price for the configured model — organizations in enforce cannot chat and shadow records nothing until an official price is loaded',
        { model },
      )
      return 'missing'
    }
    log.info('Quota pricing: the configured model has a price.', { model })
    return 'configured'
  } catch (error) {
    // The repository contract is "never throws"; this keeps startup safe anyway.
    log.warn('Quota pricing check threw unexpectedly', { model, message: error instanceof Error ? error.message : String(error) })
    return 'unverified'
  }
}
