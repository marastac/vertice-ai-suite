import { useState } from 'react'
import { Webhook } from 'lucide-react'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import type { BadgeVariant } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { canManageWebhooks, useOrganization } from '@/entities/organization'
import { useWebhookConfigQuery } from '@/entities/webhook'
import { WebhookConfigModal } from './WebhookConfigModal'

export function WebhookIntegrationCard() {
  const { role } = useOrganization()
  const canManage = canManageWebhooks(role)
  const { data: config, isLoading } = useWebhookConfigQuery()
  const [isModalOpen, setIsModalOpen] = useState(false)

  let statusLabel: string
  let statusVariant: BadgeVariant
  if (isLoading) {
    statusLabel = 'Cargando…'
    statusVariant = 'neutral'
  } else if (!config) {
    statusLabel = 'No configurado'
    statusVariant = 'neutral'
  } else if (config.isActive) {
    statusLabel = 'Activo'
    statusVariant = 'success'
  } else {
    statusLabel = 'Inactivo'
    statusVariant = 'warning'
  }

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="flex items-center justify-between">
            <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
              <Webhook className="size-4" />
            </span>
            <Badge variant={statusVariant}>{statusLabel}</Badge>
          </div>
          <div>
            <CardTitle>Webhooks</CardTitle>
            <CardDescription className="mt-1">Envía los nuevos leads a cualquier endpoint en tiempo real.</CardDescription>
          </div>
          {canManage ? (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setIsModalOpen(true)}>
              {config ? 'Configurar' : 'Conectar'}
            </Button>
          ) : (
            <p className="text-center text-xs text-slate-500">
              Solo el propietario o un administrador pueden configurar esta integración.
            </p>
          )}
        </CardContent>
      </Card>

      {canManage && <WebhookConfigModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />}
    </>
  )
}
