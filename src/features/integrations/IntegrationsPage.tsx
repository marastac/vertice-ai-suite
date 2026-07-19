import { Plug, Webhook } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'

interface MockIntegration {
  id: string
  name: string
  description: string
  icon: LucideIcon
}

const mockIntegrations: MockIntegration[] = [
  { id: 'webhook', name: 'Webhooks', description: 'Envía los nuevos leads a cualquier endpoint en tiempo real.', icon: Webhook },
  { id: 'hubspot', name: 'HubSpot', description: 'Sincroniza los leads calificados directamente con HubSpot CRM.', icon: Plug },
  { id: 'zapier', name: 'Zapier', description: 'Conecta Lead AI con miles de aplicaciones.', icon: Plug },
  { id: 'slack', name: 'Slack', description: 'Recibe una notificación en cuanto un lead se califica.', icon: Plug },
]

export function IntegrationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Integraciones" description="Conecta Lead AI con las herramientas que ya usa tu agencia." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mockIntegrations.map((integration) => (
          <Card key={integration.id}>
            <CardContent className="flex flex-col gap-4 pt-5">
              <div className="flex items-center justify-between">
                <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
                  <integration.icon className="size-4" />
                </span>
                <Badge variant="neutral">No conectado</Badge>
              </div>
              <div>
                <CardTitle>{integration.name}</CardTitle>
                <CardDescription className="mt-1">{integration.description}</CardDescription>
              </div>
              <Button variant="outline" size="sm" disabled className="w-full">
                Conectar
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
