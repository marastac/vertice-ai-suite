import { AppError } from '../lib/errors.js'
import { generateWebhookSecret } from '../lib/webhook-signature.js'
import { supabaseAdmin } from '../lib/supabase-client.js'

export interface WebhookConfigurationPublic {
  id: string
  organizationId: string
  url: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** Internal-only shape — includes `secret`. Never return this directly from a route handler; always go through toPublicConfig() first. */
export interface WebhookConfigurationRow {
  id: string
  organization_id: string
  url: string
  is_active: boolean
  secret: string
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface WebhookDeliveryRow {
  id: string
  organization_id: string
  /** Nullable — ON DELETE SET NULL if the organization deletes its webhook configuration after this row was enqueued (see migrations-webhooks.sql). The history row survives; there is simply nothing left to deliver to. See webhook-worker.ts's handling of a null value here. */
  webhook_configuration_id: string | null
  event_type: string
  /** Nullable — ON DELETE SET NULL if the referenced lead is later deleted. `payload` already holds a full snapshot of the lead, so the row stays meaningful as history either way. */
  lead_id: string | null
  payload: Record<string, unknown>
  status: 'pending' | 'processing' | 'delivered' | 'failed'
  attempts: number
  next_attempt_at: string | null
  locked_at: string | null
  last_attempted_at: string | null
  last_error: string | null
  response_status: number | null
  created_at: string
  delivered_at: string | null
}

// The one function allowed to turn a full row (with `secret`) into
// something a route handler can send to the browser. Every GET/PUT
// response in routes/webhooks.ts is built by calling this — there is
// exactly one place in the whole backend where a leak of `secret` into a
// JSON response could happen, and this is it.
function toPublicConfig(row: WebhookConfigurationRow): WebhookConfigurationPublic {
  return {
    id: row.id,
    organizationId: row.organization_id,
    url: row.url,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function client() {
  if (!supabaseAdmin) {
    throw new AppError(503, 'La función de Webhooks no está configurada en el servidor todavía.')
  }
  return supabaseAdmin
}

export const webhookRepository = {
  /** Safe to return to the browser — never includes `secret`. */
  async getConfig(organizationId: string): Promise<WebhookConfigurationPublic | null> {
    const { data, error } = await client()
      .from('webhook_configurations')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) throw new AppError(500, 'No se pudo leer la configuración del webhook.', error.message)
    return data ? toPublicConfig(data as WebhookConfigurationRow) : null
  },

  /** Internal-only — includes `secret`. Used only by the /test route and the delivery worker, never returned to a route handler's JSON response directly. */
  async getConfigWithSecret(organizationId: string): Promise<WebhookConfigurationRow | null> {
    const { data, error } = await client()
      .from('webhook_configurations')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) throw new AppError(500, 'No se pudo leer la configuración del webhook.', error.message)
    return (data as WebhookConfigurationRow) ?? null
  },

  /** Internal-only, by id — used by the worker (a delivery row only carries webhook_configuration_id, not organization_id-keyed access). */
  async getConfigById(id: string): Promise<WebhookConfigurationRow | null> {
    const { data, error } = await client().from('webhook_configurations').select('*').eq('id', id).maybeSingle()
    if (error) throw new AppError(500, 'No se pudo leer la configuración del webhook.', error.message)
    return (data as WebhookConfigurationRow) ?? null
  },

  /** Always mints a fresh secret — only call once per organization (routes/webhooks.ts checks getConfig() first and calls this only when nothing exists yet). */
  async createConfig(params: {
    organizationId: string
    url: string
    isActive: boolean
    createdBy: string
  }): Promise<WebhookConfigurationPublic> {
    const { data, error } = await client()
      .from('webhook_configurations')
      .insert({
        organization_id: params.organizationId,
        url: params.url,
        is_active: params.isActive,
        secret: generateWebhookSecret(),
        created_by: params.createdBy,
      })
      .select('*')
      .single()
    if (error) throw new AppError(500, 'No se pudo crear la configuración del webhook.', error.message)
    return toPublicConfig(data as WebhookConfigurationRow)
  },

  /** Explicit whitelist — url/isActive only. Never touches `secret`; there is no rotation feature in this MVP. */
  async updateConfig(
    organizationId: string,
    patch: { url?: string; isActive?: boolean },
  ): Promise<WebhookConfigurationPublic> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.url !== undefined) row.url = patch.url
    if (patch.isActive !== undefined) row.is_active = patch.isActive

    const { data, error } = await client()
      .from('webhook_configurations')
      .update(row)
      .eq('organization_id', organizationId)
      .select('*')
      .single()
    if (error) throw new AppError(500, 'No se pudo actualizar la configuración del webhook.', error.message)
    return toPublicConfig(data as WebhookConfigurationRow)
  },

  /** Atomic claim via the SQL function in migrations-webhooks.sql — see its doc comment for why this can't be a plain select-then-update from here. */
  async claimDeliveries(limit: number, leaseSeconds: number): Promise<WebhookDeliveryRow[]> {
    const { data, error } = await client().rpc('claim_webhook_deliveries', {
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    })
    if (error) throw new AppError(500, 'No se pudieron reclamar entregas de webhook.', error.message)
    return (data as WebhookDeliveryRow[]) ?? []
  },

  async markDelivered(id: string, responseStatus: number | null): Promise<void> {
    const { error } = await client()
      .from('webhook_deliveries')
      .update({
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        response_status: responseStatus,
        last_error: null,
      })
      .eq('id', id)
    if (error) throw new AppError(500, 'No se pudo actualizar la entrega de webhook.', error.message)
  },

  /** Schedules another attempt — status goes back to 'pending' so a later claim picks it up once next_attempt_at arrives. */
  async markRetry(
    id: string,
    params: { nextAttemptAt: string; lastError: string; responseStatus: number | null },
  ): Promise<void> {
    const { error } = await client()
      .from('webhook_deliveries')
      .update({
        status: 'pending',
        next_attempt_at: params.nextAttemptAt,
        last_error: params.lastError,
        response_status: params.responseStatus,
      })
      .eq('id', id)
    if (error) throw new AppError(500, 'No se pudo actualizar la entrega de webhook.', error.message)
  },

  async markFailedPermanently(id: string, params: { lastError: string; responseStatus: number | null }): Promise<void> {
    const { error } = await client()
      .from('webhook_deliveries')
      .update({
        status: 'failed',
        last_error: params.lastError,
        response_status: params.responseStatus,
      })
      .eq('id', id)
    if (error) throw new AppError(500, 'No se pudo actualizar la entrega de webhook.', error.message)
  },

  /** Simple abuse guard — see webhook-worker.ts for how this is used (deferred, not dropped). */
  async countRecentDeliveriesForOrganization(organizationId: string, sinceIso: string): Promise<number> {
    const { count, error } = await client()
      .from('webhook_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .gte('created_at', sinceIso)
    if (error) throw new AppError(500, 'No se pudo verificar el volumen de entregas.', error.message)
    return count ?? 0
  },
}
