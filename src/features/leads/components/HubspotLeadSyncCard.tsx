import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Link2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Button } from '@/shared/ui/Button'
import { canSyncLeadToHubspot, useOrganization } from '@/entities/organization'
import { useHubspotConnectionQuery, useHubspotContactLinkQuery, useSyncLeadToHubspotMutation } from '@/entities/hubspot'
import { formatLeadDateTime } from '@/entities/lead'
import type { Lead } from '@/entities/lead'

// Mirrors the backend's own defensive check
// (server/src/services/hubspot-sync-service.ts's SIMPLE_EMAIL_PATTERN) —
// not a full RFC 5322 validator, just enough to decide whether to offer the
// send action before the backend would reject it outright. This never
// invents or requests a different email; it only reads lead.email as-is.
const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface HubspotLeadSyncCardProps {
  lead: Lead
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'No se pudo sincronizar el lead con HubSpot.'
}

/**
 * Manual "Enviar a HubSpot" action for one lead — lives in the lead detail
 * page, not per-row in LeadsTable (see CLAUDE.md's HubSpot integration
 * notes for why). Reads TWO independent things: whether the organization
 * has a working HubSpot connection at all (useHubspotConnectionQuery(),
 * already used by HubspotIntegrationCard) and this specific lead's
 * persisted sync status (useHubspotContactLinkQuery()) — the two are
 * orthogonal, since a lead can be unsynced even when the connection itself
 * is healthy.
 */
export function HubspotLeadSyncCard({ lead }: HubspotLeadSyncCardProps) {
  const navigate = useNavigate()
  const { role } = useOrganization()
  const canSync = canSyncLeadToHubspot(role)

  const { data: connection, isLoading: isConnectionLoading } = useHubspotConnectionQuery()
  const { data: contactLink, isLoading: isLinkLoading } = useHubspotContactLinkQuery(lead.id)
  const syncMutation = useSyncLeadToHubspotMutation(lead.id)

  const hasValidEmail = SIMPLE_EMAIL_PATTERN.test(lead.email.trim())

  // Belt-and-suspenders against a double-click racing React's own
  // re-render — Button already disables itself via isLoading/disabled once
  // isPending flips, but this makes the intent explicit at the call site too.
  function handleSync() {
    if (syncMutation.isPending) return
    syncMutation.mutate()
  }

  // The mutation's own error (this session's most recent attempt) takes
  // priority; if there isn't one, fall back to a PERSISTED failure from
  // hubspot_contact_links (a lead that synced successfully before, then
  // failed on a later attempt — see server/src/services/
  // hubspot-sync-service.ts's recordSyncFailure() for why a lead that has
  // NEVER synced successfully has no persisted failure to show here at all).
  const liveErrorMessage = syncMutation.isError ? extractErrorMessage(syncMutation.error) : null
  const persistedErrorMessage = !liveErrorMessage && contactLink?.lastSyncStatus === 'failed' ? contactLink.lastSyncError : null
  const errorMessage = liveErrorMessage ?? persistedErrorMessage
  const isSynced = !errorMessage && contactLink?.lastSyncStatus === 'synced'

  // Same underlying action (call the sync mutation again) regardless of
  // label — "Actualizar" and "Reintentar" are just this button's copy for
  // an already-synced vs. a failed lead; a second upsert by the same email
  // simply updates the existing HubSpot contact (see hubspot-contacts.ts).
  const buttonLabel = syncMutation.isPending ? 'Enviando…' : errorMessage ? 'Reintentar' : isSynced ? 'Actualizar en HubSpot' : 'Enviar a HubSpot'

  let content: ReactNode
  if (isConnectionLoading) {
    content = <p className="text-sm text-slate-500">Cargando…</p>
  } else if (!connection) {
    // CASE A — not connected at all.
    content = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-400">Conecta HubSpot desde Integraciones para poder enviar este lead.</p>
        <Button variant="outline" size="sm" className="w-fit" onClick={() => navigate('/integrations')}>
          Ir a Integraciones
        </Button>
      </div>
    )
  } else if (connection.needsReauth) {
    // CASE F — connected before, but the token refresh definitively failed.
    // No automatic retry loop — just the message, once, on every render.
    content = (
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
        <AlertCircle className="size-4 shrink-0" />
        HubSpot necesita volver a conectarse.
      </div>
    )
  } else if (!hasValidEmail) {
    // Lead-data gap — applies regardless of role; never invents/requests a
    // different email, and never sends lead data to the endpoint (the
    // backend loads the lead itself by id — see api-client.ts).
    content = <p className="text-sm text-slate-400">Este lead necesita un correo electrónico para enviarse a HubSpot.</p>
  } else if (isLinkLoading) {
    content = <p className="text-sm text-slate-500">Cargando estado…</p>
  } else {
    content = (
      <div className="flex flex-col gap-3">
        {isSynced && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <div>
              <p>Sincronizado con HubSpot</p>
              {contactLink?.lastSyncedAt && (
                <p className="text-xs text-emerald-400/80">Última sincronización: {formatLeadDateTime(contactLink.lastSyncedAt)}</p>
              )}
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            {errorMessage}
          </div>
        )}

        {!isSynced && !errorMessage && <p className="text-sm text-slate-500">Este lead todavía no se ha enviado a HubSpot.</p>}

        {canSync ? (
          // CASE B/C/D/E — an active button; disabled while sending, its
          // own disabled state (via Button's isLoading) prevents a
          // double-submit.
          <Button variant="outline" size="sm" className="w-fit" onClick={handleSync} isLoading={syncMutation.isPending}>
            {buttonLabel}
          </Button>
        ) : (
          // CASE G — viewer sees the status above but no active control.
          <p className="text-xs text-slate-500">Solo el propietario, un administrador o un miembro pueden enviar este lead.</p>
        )}
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>HubSpot</CardTitle>
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
            <Link2 className="size-4" />
          </span>
        </div>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  )
}
