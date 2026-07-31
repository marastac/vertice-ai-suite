import type { NextFunction, Request, Response } from 'express'
import { logger } from './logger.js'

/** An error safe to surface to the client, with a Spanish user-facing message. */
export class AppError extends Error {
  status: number
  publicMessage: string

  constructor(status: number, publicMessage: string, internalMessage?: string) {
    super(internalMessage ?? publicMessage)
    this.status = status
    this.publicMessage = publicMessage
  }
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Recurso no encontrado.' })
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error(err.message)
    res.status(err.status).json({ error: err.publicMessage })
    return
  }

  // Never leak raw provider/internal error details to the browser.
  logger.error('Unhandled error', { message: err instanceof Error ? err.message : String(err) })
  res.status(500).json({ error: 'Ha ocurrido un error inesperado. Inténtalo de nuevo.' })
}
