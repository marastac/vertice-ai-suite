import cors from 'cors'
import express from 'express'
import { config } from './config.js'
import { errorHandler, notFoundHandler } from './lib/errors.js'
import { chatRouter } from './routes/chat.js'
import { healthRouter } from './routes/health.js'

export function createApp() {
  const app = express()

  app.use(
    cors({
      origin: config.corsOrigins,
    }),
  )
  // Small limit: this API only ever receives short chat messages and config objects.
  app.use(express.json({ limit: '100kb' }))

  app.use('/api', healthRouter)
  app.use('/api/chat', chatRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
