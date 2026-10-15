import { createApp } from './app.js'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { createSupabaseSessionSnapshotStore } from './repositories/backend-session-store.js'
import { sessionRepository } from './repositories/session-repository.js'
import { createDurableSessionSync } from './services/durable-session-sync.js'
import type { DurableSessionSync } from './services/durable-session-sync.js'
import { checkQuotaPricingAtStartup } from './services/quota-pricing-check.js'
import { startQuotaReconciler, stopQuotaReconciler } from './services/quota-reconciler.js'
import { startWebhookWorker, stopWebhookWorker } from './services/webhook-worker.js'

const app = createApp()

// Opt-in durable copy of chat sessions (CHAT_SESSION_STORE=postgres). With the
// default ('file') none of this runs and startup is exactly as before.
let durableSessions: DurableSessionSync | null = null
if (config.chatSessionStore === 'postgres') {
  if (config.isWebhooksConfigured) {
    durableSessions = createDurableSessionSync({ repository: sessionRepository, store: createSupabaseSessionSnapshotStore() })
    // Recover BEFORE listening, so a visitor's in-progress conversation exists
    // again by the time its next message arrives. Never throws.
    await durableSessions.hydrate()
    durableSessions.start()
  } else {
    logger.warn('CHAT_SESSION_STORE=postgres requires SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — keeping sessions in sessions.json only.')
  }
}

const server = app.listen(config.port, () => {
  logger.info(`Lead AI backend listening on http://localhost:${config.port}`, {
    aiConfigured: config.isAiConfigured,
    webhooksConfigured: config.isWebhooksConfigured,
    // Diagnostics only — every value here is a Boolean() coercion of an
    // already-computed config field, never the underlying string/Buffer
    // itself. Lets a startup log answer "which of the five conditions
    // isHubspotConfigured needs is missing" without ever printing an env
    // var value. See config.ts's isHubspotConfigured for the exact
    // five-condition check this mirrors.
    hubspotClientIdPresent: Boolean(config.hubspotClientId),
    hubspotClientSecretPresent: Boolean(config.hubspotClientSecret),
    hubspotRedirectUriPresent: Boolean(config.hubspotRedirectUri),
    frontendUrlPresent: Boolean(config.frontendUrl),
    hubspotEncryptionKeyValid: Boolean(config.hubspotTokenEncryptionKey),
    isHubspotConfigured: config.isHubspotConfigured,
  })
  // Started only after the HTTP server is already listening — an
  // unconfigured or slow-to-start worker must never delay or block the
  // rest of the backend (chat/Anthropic) from serving requests.
  startWebhookWorker()
  // Same reasoning; a no-op (one log line) while CHAT_QUOTAS_ENABLED is off.
  startQuotaReconciler()
  // Read-only, never throws, not awaited; also a no-op while the flag is off.
  void checkQuotaPricingAtStartup()
})

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down.`)
  stopWebhookWorker()
  stopQuotaReconciler()
  // Let pending durable session copies finish (bounded by their own timeouts).
  void (durableSessions ? durableSessions.flush() : Promise.resolve()).finally(() => server.close(() => process.exit(0)))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
