import { Router } from 'express'
import { createRateLimiter } from '../lib/rate-limit.js'
import { AppError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { createSessionBodySchema, postMessageBodySchema } from '../schemas/chat.js'
import { aiProvider } from '../services/ai-provider.js'
import { createSession, getSession, handleIncomingMessage } from '../services/chat-service.js'

export const chatRouter = Router()

const REQUEST_TIMEOUT_MS = 45_000

// Public endpoints (no auth in this MVP) — keep this modest so one visitor
// can't exhaust the Anthropic quota for everyone else.
const rateLimit = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 40 })

chatRouter.post('/sessions', rateLimit, async (req, res, next) => {
  try {
    if (!aiProvider.isConfigured) {
      throw new AppError(503, 'El chat con IA no está configurado en el servidor todavía.')
    }

    const parsed = createSessionBodySchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(400, 'La configuración del chat enviada no es válida.')
    }

    // createSession() owns EVERY security-relevant decision about this
    // session's config now — including isActive — never this route. For a
    // `resolved` organization it loads the real chat_configuration
    // server-side and ignores parsed.data.config entirely; that client-sent
    // config is only ever used as-is for a `not_configured` (local/dev, no
    // Supabase) backend. See chat-service.ts::createSession() and the
    // config-trust hardening report for the full reasoning — checking
    // `parsed.data.config.isActive` here would both be redundant with that
    // and, for `resolved`, actively wrong (a client-controlled value with
    // no server verification).
    const session = await createSession(parsed.data.orgSlug, parsed.data.config)
    res.status(201).json({
      sessionId: session.id,
      welcomeMessage: session.config.welcomeMessage,
      assistantName: session.config.assistantName,
    })
  } catch (error) {
    next(error)
  }
})

chatRouter.post('/sessions/:sessionId/messages', rateLimit, async (req, res, next) => {
  const { sessionId } = req.params

  try {
    if (!aiProvider.isConfigured) {
      throw new AppError(503, 'El chat con IA no está configurado en el servidor todavía.')
    }

    const session = getSession(sessionId)
    if (!session) {
      throw new AppError(404, 'Esta conversación ya no está disponible. Actualiza la página para iniciar una nueva.')
    }

    const parsedBody = postMessageBodySchema.safeParse(req.body)
    if (!parsedBody.success) {
      throw new AppError(400, parsedBody.error.issues[0]?.message ?? 'Mensaje no válido.')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    // `req` (the readable request stream) can emit 'close' as soon as its
    // body has been fully read by the JSON body-parser — i.e. almost
    // immediately, well before the client actually disconnects. `res` only
    // emits 'close' when the underlying connection itself ends, so it's the
    // correct signal for "the client went away mid-stream". Guard with
    // `responseEnded` so our own `res.end()` below doesn't self-trigger it.
    let responseEnded = false
    res.on('close', () => {
      if (!responseEnded) controller.abort()
    })

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    function sendEvent(event: string, data: unknown) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      await handleIncomingMessage(session, parsedBody.data.message, controller.signal, {
        onDelta: (text) => sendEvent('delta', { text }),
        onQualification: (qualification) => sendEvent('qualification', { qualification }),
        onLimitReached: (message) => sendEvent('conversation_limit_reached', { message }),
      })
      sendEvent('done', {})
    } catch (streamError) {
      logger.error('Chat stream failed', {
        sessionId,
        message: streamError instanceof Error ? streamError.message : String(streamError),
      })
      sendEvent('error', { message: 'No se pudo generar una respuesta. Inténtalo de nuevo.' })
    } finally {
      clearTimeout(timeout)
      responseEnded = true
      res.end()
    }
  } catch (error) {
    next(error)
  }
})
