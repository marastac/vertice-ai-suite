import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Card, CardContent } from '@/shared/ui/Card'
import { useAuth } from '@/entities/auth'
import {
  clearPendingInviteToken,
  inviteStatusLabel,
  organizationRoleLabel,
  setLastActiveOrganizationId,
  setPendingInviteToken,
  translateInviteError,
  useAcceptInviteMutation,
  useInvitePreviewQuery,
} from '@/entities/organization'
import { InviteStatusMessage } from './components/InviteStatusMessage'

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>()
  const { user } = useAuth()
  const previewQuery = useInvitePreviewQuery(token)
  const acceptMutation = useAcceptInviteMutation()
  const [acceptError, setAcceptError] = useState<string | null>(null)

  // Set as soon as the page loads, regardless of auth state — OrganizationProvider
  // will read this (once wired) to skip auto-provisioning a personal organization
  // while a visitor is mid-flow accepting an invite to an existing one.
  useEffect(() => {
    if (token) setPendingInviteToken(token)
  }, [token])

  const invite = previewQuery.data
  const isInvalid = previewQuery.isError || (previewQuery.isSuccess && invite === null)
  const isNotUsable = Boolean(invite && !invite.isUsable)

  // Terminal states — this token will never be completable, so there's no
  // reason to keep protecting auto-provisioning for it.
  useEffect(() => {
    if (isInvalid || isNotUsable) clearPendingInviteToken()
  }, [isInvalid, isNotUsable])

  async function handleAccept() {
    if (!token) return
    setAcceptError(null)
    try {
      const result = await acceptMutation.mutateAsync(token)
      clearPendingInviteToken()
      // Without this, OrganizationProvider would default to the user's oldest
      // membership (listMyMemberships is ordered by created_at ascending) on the
      // reload below, not the organization they just joined.
      setLastActiveOrganizationId(result.organizationId)
      // Hard redirect, not React Router navigation: forces OrganizationProvider
      // to remount and re-fetch memberships from scratch, now that accept_invite()
      // has created the organization_members row.
      window.location.assign('/dashboard')
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setAcceptError(message ? translateInviteError(message) : 'No se pudo procesar la invitación. Inténtalo de nuevo.')
      clearPendingInviteToken()
    }
  }

  return (
    <div className="min-h-screen bg-vertice-bg px-4 py-10 text-slate-100 sm:px-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center justify-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
            <Sparkles className="size-4 text-white" />
          </span>
          <span className="text-sm font-semibold text-white">Lead AI</span>
        </div>

        {previewQuery.isLoading && (
          <Card className="p-8">
            <div className="flex justify-center">
              <Loader2 className="size-6 animate-spin text-slate-400" />
            </div>
          </Card>
        )}

        {!previewQuery.isLoading && isInvalid && (
          <InviteStatusMessage
            title="Invitación no válida"
            description="El enlace que abriste no corresponde a ninguna invitación. Pide a quien te invitó que te comparta uno nuevo."
          />
        )}

        {!previewQuery.isLoading && !isInvalid && isNotUsable && invite && (
          <InviteStatusMessage
            title={`Invitación ${inviteStatusLabel[invite.status].toLowerCase()}`}
            description="Esta invitación ya no se puede usar. Pide a quien te invitó que te envíe una nueva."
          />
        )}

        {!previewQuery.isLoading && !isInvalid && !isNotUsable && invite && (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
              <h1 className="text-lg font-semibold text-white">Te invitaron a {invite.organizationName}</h1>
              <p className="text-sm text-slate-400">
                Rol ofrecido: <span className="text-slate-200">{organizationRoleLabel[invite.role]}</span>
              </p>

              {!user && (
                <div className="flex w-full flex-col gap-2 pt-2">
                  <Link to="/login" state={{ from: { pathname: `/accept-invite/${token}` } }}>
                    <Button className="w-full">Iniciar sesión</Button>
                  </Link>
                  <Link to="/register" state={{ from: { pathname: `/accept-invite/${token}` } }}>
                    <Button variant="outline" className="w-full">
                      Crear cuenta
                    </Button>
                  </Link>
                </div>
              )}

              {user && (
                <div className="flex w-full flex-col gap-2 pt-2">
                  {acceptError && (
                    <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                      {acceptError}
                    </p>
                  )}
                  <Button className="w-full" isLoading={acceptMutation.isPending} onClick={handleAccept}>
                    Aceptar invitación
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
