import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Plug } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardDescription, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { useOrganization } from '@/entities/organization'
import { hubspotKeys } from '@/entities/hubspot'
import { WebhookIntegrationCard } from './components/WebhookIntegrationCard'
import { HubspotIntegrationCard } from './components/HubspotIntegrationCard'

// Still roadmap-only — Zapier/Slack have no real provider wired up yet (no
// OAuth, no external API calls). Webhooks and HubSpot have both graduated
// out of this list into their own real components — see
// WebhookIntegrationCard/entities/webhook and
// HubspotIntegrationCard/entities/hubspot.
interface IntegrationRoadmapItem {
  id: string
  name: string
  description: string
  icon: LucideIcon
}

const COMING_SOON_INTEGRATIONS: IntegrationRoadmapItem[] = [
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

type HubspotCallbackStatus = 'connected' | 'error'

export function IntegrationsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { organization } = useOrganization()
  const queryClient = useQueryClient()

  // Captured once, from the URL this page was loaded with — GET
  // /api/hubspot/oauth/callback redirects back here as
  // /integrations?hubspot=connected|error. Deliberately a lazy useState
  // initializer, not derived from `searchParams` on every render: the
  // effect below removes the query param right after reading it (so a
  // page refresh doesn't keep re-showing the banner), and re-deriving from
  // `searchParams` after that would make the banner disappear instantly
  // instead of staying visible for the user to actually read.
  const [hubspotCallbackStatus] = useState<HubspotCallbackStatus | null>(() => {
    const value = searchParams.get('hubspot')
    return value === 'connected' || value === 'error' ? value : null
  })

  useEffect(() => {
    if (!hubspotCallbackStatus) return
    if (hubspotCallbackStatus === 'connected') {
      // The card's own query would eventually refetch on its own, but
      // invalidating here makes the "Conectado" status appear immediately
      // instead of waiting for the next natural refetch trigger.
      queryClient.invalidateQueries({ queryKey: hubspotKeys.connection(organization?.id) })
    }
    setSearchParams(
      (params) => {
        params.delete('hubspot')
        return params
      },
      { replace: true },
    )
    // Intentionally run only once, right after mount, for the query param
    // this specific page load carried — not meant to re-run if
    // organization/searchParams change afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integraciones"
        description="Conecta Lead AI con las herramientas que ya utiliza tu negocio."
      />

      {hubspotCallbackStatus === 'connected' && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          <CheckCircle2 className="size-4 shrink-0" />
          HubSpot se conectó correctamente.
        </div>
      )}
      {hubspotCallbackStatus === 'error' && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertCircle className="size-4 shrink-0" />
          No se pudo completar la conexión con HubSpot. Inténtalo de nuevo.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <WebhookIntegrationCard />
        <HubspotIntegrationCard />

        {COMING_SOON_INTEGRATIONS.map((integration) => (
          <Card key={integration.id}>
            <CardContent className="flex flex-col gap-4 pt-5">
              <div className="flex items-center justify-between">
                <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
                  <integration.icon className="size-4" />
                </span>
                {/* 'info', not 'neutral' — a grey "No conectado" badge reads as
                    "you could connect this but haven't", which isn't true
                    yet. "Próximamente" is the honest state for these two. */}
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
