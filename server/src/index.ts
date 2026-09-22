import { createApp } from './app.js'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { startWebhookWorker, stopWebhookWorker } from './services/webhook-worker.js'

const app = createApp()

const server = app.listen(config.port, () => {
  logger.info(`Lead AI backend listening on http://localhost:${config.port}`, {
    aiConfigured: config.isAiConfigured,
    webhooksConfigured: config.isWebhooksConfigured,
  })
  // Started only after the HTTP server is already listening — an
  // unconfigured or slow-to-start worker must never delay or block the
  // rest of the backend (chat/Anthropic) from serving requests.
  startWebhookWorker()
})

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down.`)
  stopWebhookWorker()
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
