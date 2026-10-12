import type { NextFunction, Request, Response } from 'express'

interface Bucket {
  count: number
  resetAt: number
}

/**
 * Small in-memory sliding-window rate limiter for the public chat endpoints.
 * Good enough for a single-process local MVP — swap for a shared store
 * (Redis, etc.) before running more than one server instance.
 */
export function createRateLimiter(options: { windowMs: number; max: number; message?: string }) {
  const buckets = new Map<string, Bucket>()

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const key = req.ip ?? 'unknown'
    const now = Date.now()
    const bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs })
      next()
      return
    }

    if (bucket.count >= options.max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfterSeconds))
      res.status(429).json({ error: options.message ?? 'Has enviado demasiados mensajes. Espera un momento e inténtalo de nuevo.' })
      return
    }

    bucket.count += 1
    next()
  }
}

/**
 * Applies `middleware` only while `isEnabled()` is true, evaluated on every
 * request; otherwise passes straight through. Used to add protections that
 * belong to an opt-in feature (e.g. CHAT_QUOTAS_ENABLED) without changing
 * any behavior while that feature is off.
 */
export function onlyWhen(
  isEnabled: () => boolean,
  middleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  return function conditionalMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!isEnabled()) {
      next()
      return
    }
    middleware(req, res, next)
  }
}
