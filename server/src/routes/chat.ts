import { Router } from 'express'
import { createRateLimiter } from '../lib/rate-limit.js'
import { AppError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { createSessionBodySchema, postMessageBodySchema } from '../schemas/chat.js'
import { aiProvider } from '../services/ai-provider.js'
import { createSession, extractQualification, getSession, streamAssistantReply } from '../services/chat-service.js'

export const chatRouter = Router()

const REQUEST_TIMEOUT_MS = 45_000

// Public endpoints (no auth in this MVP) — keep this modest so one visitor
// can't exhaust the Anthropic quota for everyone else.
const rateLimit = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 40 })

chatRouter.post('/sessions', rateLimit, (req, res, next) => {
  try {
    if (!aiProvider.isConfigured) {
      throw new AppError(503, 'El chat con IA no está configurado en el servidor todavía.')
    }

    const parsed = createSessionBodySchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(400, 'La configuración del chat enviada no es válida.')
    }

    if (!parsed.data.config.isActive) {
      throw new AppError(403, 'Este chat no está activo en este momento.')
    }

    const session = createSession(parsed.data.orgSlug, parsed.data.config)
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
      for await (const delta of streamAssistantReply(session, parsedBody.data.message, controller.signal)) {
        sendEvent('delta', { text: delta })
      }

      const qualification = await extractQualification(session, controller.signal)
      sendEvent('qualification', { qualification })
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
