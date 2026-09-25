import { useState } from 'react'
import { AlertCircle, Link2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import type { BadgeVariant } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { canManageHubspot, useOrganization } from '@/entities/organization'
import { useConnectHubspotMutation, useDisconnectHubspotMutation, useHubspotConnectionQuery } from '@/entities/hubspot'

export function HubspotIntegrationCard() {
  const { role } = useOrganization()
  const canManage = canManageHubspot(role)
  const { data: connection, isLoading } = useHubspotConnectionQuery()
  const connectMutation = useConnectHubspotMutation()
  const disconnectMutation = useDisconnectHubspotMutation()
  const [connectError, setConnectError] = useState<string | null>(null)
  const [isDisconnectConfirmOpen, setIsDisconnectConfirmOpen] = useState(false)

  let statusLabel: string
  let statusVariant: BadgeVariant
  if (isLoading) {
    statusLabel = 'Cargando…'
    statusVariant = 'neutral'
  } else if (!connection) {
    statusLabel = 'No conectado'
    statusVariant = 'neutral'
  } else if (connection.needsReauth) {
    statusLabel = 'Reconexión necesaria'
    statusVariant = 'warning'
  } else {
    statusLabel = 'Conectado'
    statusVariant = 'success'
  }

  async function handleConnect() {
    setConnectError(null)
    try {
      // startHubspotOauth() only fetches the URL — the actual browser
      // navigation happens here, a real top-level redirect (never a
      // fetch), so the user lands on HubSpot's own consent screen.
      const url = await connectMutation.mutateAsync()
      window.location.href = url
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'No se pudo iniciar la conexión con HubSpot.')
    }
  }

  async function handleConfirmDisconnect() {
    try {
      await disconnectMutation.mutateAsync()
      setIsDisconnectConfirmOpen(false)
    } catch {
      // Deliberately don't close the dialog on failure — the backend only
      // rejects this when it kept the connection (see
      // disconnectHubspotConnection()'s doc comment in routes/hubspot.ts),
      // so the error stays visible in the dialog itself (via
      // disconnectMutation.error below) and the admin can retry from there.
    }
  }

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="flex items-center justify-between">
            <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
              <Link2 className="size-4" />
            </span>
            <Badge variant={statusVariant}>{statusLabel}</Badge>
          </div>
          <div>
            <CardTitle>HubSpot CRM</CardTitle>
            <CardDescription className="mt-1">
              {connection
                ? `Conectado al portal de HubSpot ${connection.hubPortalId}. El envío manual de leads como contactos estará disponible próximamente.`
                : 'Conecta tu cuenta de HubSpot CRM. El envío manual de leads como contactos estará disponible próximamente.'}
            </CardDescription>
          </div>

          {connectError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="size-4 shrink-0" />
              {connectError}
            </div>
          )}

          {canManage ? (
            <div className="flex flex-col gap-2">
              {(!connection || connection.needsReauth) && (
                <Button variant="outline" size="sm" className="w-full" onClick={handleConnect} isLoading={connectMutation.isPending}>
                  {connection ? 'Reconectar' : 'Conectar'}
                </Button>
              )}
              {connection && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => setIsDisconnectConfirmOpen(true)}
                  disabled={connectMutation.isPending}
                >
                  Desconectar
                </Button>
              )}
            </div>
          ) : (
            <p className="text-center text-xs text-slate-500">
              Solo el propietario o un administrador pueden conectar o desconectar esta integración.
            </p>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        isOpen={isDisconnectConfirmOpen}
        title="Desconectar HubSpot"
        description="Se revocará el acceso de Lead AI a tu cuenta de HubSpot. Podrás volver a conectar cuando quieras."
        confirmLabel="Desconectar"
        variant="danger"
        isConfirming={disconnectMutation.isPending}
        error={
          disconnectMutation.isError
            ? disconnectMutation.error instanceof Error
              ? disconnectMutation.error.message
              : 'No se pudo desconectar HubSpot.'
            : undefined
        }
        onConfirm={handleConfirmDisconnect}
        onCancel={() => setIsDisconnectConfirmOpen(false)}
      />
    </>
  )
}
