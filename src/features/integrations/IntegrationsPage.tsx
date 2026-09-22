import { Plug } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { WebhookIntegrationCard } from './components/WebhookIntegrationCard'

// Still roadmap-only — HubSpot/Zapier/Slack have no real provider wired up
// yet (no OAuth, no external API calls). Webhooks graduated out of this
// list into its own real component (WebhookIntegrationCard) — see that
// file and entities/webhook/ for the first real integration.
interface IntegrationRoadmapItem {
  id: string
  name: string
  description: string
  icon: LucideIcon
}

const COMING_SOON_INTEGRATIONS: IntegrationRoadmapItem[] = [
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Sincroniza los leads calificados directamente con HubSpot CRM.',
    icon: Plug,
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'Conecta Lead AI con miles de aplicaciones.',
    icon: Plug,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Recibe una notificación en cuanto un lead se califica.',
    icon: Plug,
  },
]

export function IntegrationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integraciones"
        description="Conecta Lead AI con las herramientas que ya utiliza tu negocio."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <WebhookIntegrationCard />

        {COMING_SOON_INTEGRATIONS.map((integration) => (
          <Card key={integration.id}>
            <CardContent className="flex flex-col gap-4 pt-5">
              <div className="flex items-center justify-between">
                <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
                  <integration.icon className="size-4" />
                </span>
                {/* 'info', not 'neutral' — a grey "No conectado" badge reads as
                    "you could connect this but haven't", which isn't true
                    yet. "Próximamente" is the honest state for these three. */}
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
