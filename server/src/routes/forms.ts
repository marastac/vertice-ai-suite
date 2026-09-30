import { Router } from 'express'
import { z } from 'zod'
import { createRateLimiter } from '../lib/rate-limit.js'
import { AppError } from '../lib/errors.js'
import { submitPublicFormBodySchema } from '../schemas/forms.js'
import { createPublicFormSubmission } from '../services/form-submission-service.js'
import { supabaseAdmin } from '../lib/supabase-client.js'

export const formsRouter = Router()

const formIdParamSchema = z.string().uuid()

// Public, unauthenticated endpoint (a visitor filling /f/:formId is never
// signed in) — reuses the exact same in-memory per-IP limiter already
// protecting chat/webhooks/hubspot (lib/rate-limit.ts), no new mechanism.
// A public form submission is a much rarer action per visitor than a chat
// message, so this window/max is deliberately tighter than chat's
// (40/5min): 10 submissions per IP per 15 minutes comfortably covers a
// real visitor retrying a mistake or submitting more than one form, while
// still meaningfully capping basic automated abuse. See app.ts's
// `app.set('trust proxy', 1)` — required for req.ip to reflect the real
// visitor behind Railway's edge proxy rather than the proxy's own address.
const rateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 })

formsRouter.post('/:formId/submissions', rateLimit, async (req, res, next) => {
  try {
    // Same optionality as every other Supabase-backed feature in this
    // backend (organization-lookup.ts, chat-config-repository.ts) — there
    // is no 'local' server-side equivalent for public form submissions
    // (unlike chat's not_configured mode): forms/leads in 'local' mode live
    // entirely in the visitor's own browser localStorage, which this
    // backend has no access to and must never try to. The frontend's
    // submission-service.ts only ever calls this endpoint when
    // VITE_DATA_BACKEND === 'supabase' — see its own comment for the full
    // reasoning — so reaching this branch means either a misconfigured
    // deployment or a direct call bypassing the frontend, both correctly
    // rejected here rather than silently mishandled.
    if (!supabaseAdmin) {
      throw new AppError(503, 'El envío de formularios no está disponible en este momento.')
    }

    const formId = formIdParamSchema.safeParse(req.params.formId)
    if (!formId.success) {
      throw new AppError(404, 'Formulario no encontrado.')
    }

    const parsed = submitPublicFormBodySchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? 'El formulario enviado no es válido.')
    }

    const result = await createPublicFormSubmission(formId.data, parsed.data.answers, parsed.data.website)

    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})
