import type { Request } from 'express'
import { AppError } from '../lib/errors.js'
import { supabaseAdmin } from '../lib/supabase-client.js'

export interface AuthenticatedUser {
  id: string
  email: string | null
}

export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer'

/**
 * Verifies the `Authorization: Bearer <token>` header against Supabase Auth
 * (via the service_role admin client's auth.getUser(), which validates the
 * token's signature/expiry server-side rather than trusting a locally
 * decoded JWT) and returns the real user id. The frontend cannot forge
 * this — it can only supply a token it actually holds from its own signed-
 * in Supabase session (see entities/webhook/api-client.ts).
 */
export async function requireAuthenticatedUser(req: Request): Promise<AuthenticatedUser> {
  if (!supabaseAdmin) {
    throw new AppError(503, 'La función de Webhooks no está configurada en el servidor todavía.')
  }

  const header = req.header('authorization')
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
  if (!token) {
    throw new AppError(401, 'Falta el token de autenticación.')
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data.user) {
    throw new AppError(401, 'Sesión no válida o expirada.')
  }

  return { id: data.user.id, email: data.user.email ?? null }
}

/**
 * Confirms `userId` actually belongs to `organizationId` and returns their
 * real role there — read directly from organization_members using the
 * service_role client, never taken from anything the request body/query
 * claims. This is the check that makes it impossible for the frontend to
 * "ask" for a different organization's webhook config/test by simply
 * changing an id in the request.
 */
export async function requireOrganizationMembership(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!supabaseAdmin) {
    throw new AppError(503, 'La función de Webhooks no está configurada en el servidor todavía.')
  }

  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) throw new AppError(500, 'No se pudo verificar la organización.', error.message)
  if (!data) throw new AppError(403, 'No perteneces a esta organización.')

  return data.role as OrganizationRole
}

/** Owner/admin only — same threshold as canManageWebhooks() on the frontend and the RLS policies in supabase/migrations-webhooks.sql. Never trust a role the client claims; always call this with the value requireOrganizationMembership() returned. */
export function requireAdminRole(role: OrganizationRole): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new AppError(403, 'Solo el propietario o un administrador pueden realizar esta acción.')
  }
}
