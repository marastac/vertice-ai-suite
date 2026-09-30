import cors from 'cors'
import express from 'express'
import { config } from './config.js'
import { errorHandler, notFoundHandler } from './lib/errors.js'
import { chatRouter } from './routes/chat.js'
import { formsRouter } from './routes/forms.js'
import { healthRouter } from './routes/health.js'
import { hubspotRouter } from './routes/hubspot.js'
import { webhooksRouter } from './routes/webhooks.js'

export function createApp() {
  const app = express()

  // Required for every per-IP rate limiter in this app (lib/rate-limit.ts,
  // keyed by req.ip) to see the REAL visitor's address rather than
  // Railway's own edge proxy — without this, Express derives req.ip from
  // the raw socket, which behind a reverse proxy is the proxy itself, so
  // every visitor would collapse into the same bucket (rate-limiting
  // everyone together after the first few requests total, or none of them
  // meaningfully, depending on connection reuse). `1` trusts exactly one
  // hop in front of this process — matching Railway's single edge proxy —
  // and takes the first entry of X-Forwarded-For as req.ip; it does NOT
  // trust a client-supplied X-Forwarded-For beyond that one hop, so a
  // direct caller can't spoof an arbitrary chain to evade the limiter.
  // Fixes a pre-existing latent gap in the chat/webhooks/hubspot rate
  // limiters too (none of the three ever worked correctly by IP in
  // production before this) — not a behavior change to any of them beyond
  // making their existing, documented per-IP intent actually work.
  app.set('trust proxy', 1)

  app.use(
    cors({
      origin: config.corsOrigins,
    }),
  )
  // Small limit: this API only ever receives short chat messages, config
  // objects, and form submissions — see routes/forms.ts's own answer-count/
  // length caps for that endpoint specifically.
  app.use(express.json({ limit: '100kb' }))

  app.use('/api', healthRouter)
  app.use('/api/chat', chatRouter)
  app.use('/api/forms', formsRouter)
  app.use('/api/webhooks', webhooksRouter)
  app.use('/api/hubspot', hubspotRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
