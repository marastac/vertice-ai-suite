import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { createRateLimiter } from '../lib/rate-limit.js'
import { AppError } from '../lib/errors.js'
import { validateWebhookUrlForSaving } from '../lib/webhook-security.js'
import { webhookRepository } from '../repositories/webhook-repository.js'
import { requireAdminRole, requireAuthenticatedUser, requireOrganizationMembership } from '../services/webhook-auth.js'
import { attemptWebhookDelivery } from '../services/webhook-delivery-service.js'
import { webhookConfigBodySchema, webhookOrganizationQuerySchema, webhookTestBodySchema } from '../schemas/webhooks.js'

export const webhooksRouter = Router()

// Authenticated, dashboard-only endpoints — not the public/anonymous kind
// chat.ts rate-limits against abuse from strangers, but still worth a
// floor against a runaway frontend retry loop or a compromised session
// hammering the endpoint.
const rateLimit = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 60 })
webhooksRouter.use(rateLimit)

/** Any organization member may read the (secret-free) configuration. */
webhooksRouter.get('/config', async (req, res, next) => {
  try {
    const query = webhookOrganizationQuerySchema.parse(req.query)
    const user = await requireAuthenticatedUser(req)
    await requireOrganizationMembership(user.id, query.organizationId)

    const config = await webhookRepository.getConfig(query.organizationId)
    res.json({ config })
  } catch (error) {
    next(error)
  }
})

/** Owner/admin only — creates the configuration on first save, updates url/isActive afterward. Never accepts a `secret` field; the body schema doesn't even declare one. */
webhooksRouter.put('/config', async (req, res, next) => {
  try {
    const body = webhookConfigBodySchema.parse(req.body)
    const user = await requireAuthenticatedUser(req)
    const role = await requireOrganizationMembership(user.id, body.organizationId)
    requireAdminRole(role)

    const urlCheck = await validateWebhookUrlForSaving(body.url)
    if (!urlCheck.ok) {
      throw new AppError(400, urlCheck.reason)
    }

    const existing = await webhookRepository.getConfig(body.organizationId)
    const saved = existing
      ? await webhookRepository.updateConfig(body.organizationId, { url: body.url, isActive: body.isActive })
      : await webhookRepository.createConfig({
          organizationId: body.organizationId,
          url: body.url,
          isActive: body.isActive,
          createdBy: user.id,
        })

    res.json({ config: saved })
  } catch (error) {
    next(error)
  }
})

/**
 * Owner/admin only — sends one signed request immediately (bypassing the
 * outbox/worker entirely) using a clearly-marked `webhook.test` event, and
 * returns the outcome synchronously so the UI can show it right away.
 * Never creates a `leads` row or a `webhook_deliveries` row — this is a
 * pure, side-effect-free-on-our-own-data send.
 */
webhooksRouter.post('/test', async (req, res, next) => {
  try {
    const body = webhookTestBodySchema.parse(req.body)
    const user = await requireAuthenticatedUser(req)
    const role = await requireOrganizationMembership(user.id, body.organizationId)
    requireAdminRole(role)

    const webhookConfig = await webhookRepository.getConfigWithSecret(body.organizationId)
    if (!webhookConfig) {
      throw new AppError(404, 'No hay ningún webhook configurado todavía.')
    }

    const urlCheck = await validateWebhookUrlForSaving(webhookConfig.url)
    if (!urlCheck.ok) {
      throw new AppError(400, `La URL configurada ya no es válida: ${urlCheck.reason}`)
    }

    const deliveryId = randomUUID()
    // Same `lead` shape as the real lead.created payload (see
    // notify_lead_created() in supabase/migrations-webhooks.sql), but with
    // an all-zeros id and obviously-fake values, under a distinct
    // `webhook.test` event — a receiver built against lead.created's shape
    // can reuse its parsing code, but can never mistake this for a real lead.
    const payload = {
      event: 'webhook.test',
      event_id: deliveryId,
      timestamp: new Date().toISOString(),
      organization_id: body.organizationId,
      lead: {
        id: '00000000-0000-0000-0000-000000000000',
        name: 'Lead de prueba',
        email: 'prueba@leadai.app',
        phone: null,
        company: 'Empresa de prueba',
        position: null,
        source: 'manual',
        status: 'new',
        score: 0,
        estimated_budget: null,
        notes: 'Este es un envío de prueba generado desde Lead AI. No corresponde a un lead real.',
        form_id: null,
        submission_id: null,
        chat_session_id: null,
        created_at: new Date().toISOString(),
      },
    }
    const rawBody = JSON.stringify(payload)

    const result = await attemptWebhookDelivery({
      url: webhookConfig.url,
      secret: webhookConfig.secret,
      eventType: 'webhook.test',
      deliveryId,
      rawBody,
    })

    res.json({
      success: result.outcome === 'delivered',
      responseStatus: result.responseStatus,
      errorReason: result.errorReason,
    })
  } catch (error) {
    next(error)
  }
})
