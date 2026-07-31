import { createApp } from './app.js'
import { config } from './config.js'
import { logger } from './lib/logger.js'

const app = createApp()

app.listen(config.port, () => {
  logger.info(`Lead AI backend listening on http://localhost:${config.port}`, {
    aiConfigured: config.isAiConfigured,
  })
})
