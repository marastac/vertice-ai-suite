import { Plug, Webhook } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'

// Roadmap only — none of these are wired to a real provider yet (no OAuth,
// no external API calls, no webhook delivery). `status` exists specifically
// so a future real integration (Webhooks is the likely first candidate)
// only needs its own entry's `status` flipped to 'available' plus a real
// onClick — the card list/grid below doesn't need to change shape for that.
type IntegrationStatus = 'coming-soon'

interface IntegrationRoadmapItem {
  id: string
  name: string
  description: string
  icon: LucideIcon
  status: IntegrationStatus
}

const INTEGRATIONS: IntegrationRoadmapItem[] = [
  {
    id: 'webhook',
    name: 'Webhooks',
    description: 'Envía los nuevos leads a cualquier endpoint en tiempo real.',
    icon: Webhook,
    status: 'coming-soon',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Sincroniza los leads calificados directamente con HubSpot CRM.',
    icon: Plug,
    status: 'coming-soon',
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'Conecta Lead AI con miles de aplicaciones.',
    icon: Plug,
    status: 'coming-soon',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Recibe una notificación en cuanto un lead se califica.',
    icon: Plug,
    status: 'coming-soon',
  },
]

export function IntegrationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integraciones"
        description="Conecta Lead AI con las herramientas que ya utiliza tu negocio. Estas integraciones están en desarrollo y todavía no se pueden activar."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {INTEGRATIONS.map((integration) => (
          <Card key={integration.id}>
            <CardContent className="flex flex-col gap-4 pt-5">
              <div className="flex items-center justify-between">
                <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
                  <integration.icon className="size-4" />
                </span>
                {/* 'info', not 'neutral' — a grey "No conectado" badge reads as
                    "you could connect this but haven't", which isn't true
                    yet. "Próximamente" is the honest state for all four
                    cards today. */}
                <Badge variant="info">Próximamente</Badge>
              </div>
              <div>
                <CardTitle>{integration.name}</CardTitle>
                <CardDescription className="mt-1">{integration.description}</CardDescription>
              </div>
              <Button variant="outline" size="sm" disabled className="w-full">
                Próximamente
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
