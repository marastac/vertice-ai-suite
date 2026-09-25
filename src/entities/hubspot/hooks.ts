import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/entities/auth'
import { useOrganization } from '@/entities/organization'
import { disconnectHubspot, fetchHubspotConnection, startHubspotOauth } from './api-client'

export const hubspotKeys = {
  all: ['hubspot-connection'] as const,
  connection: (organizationId: string | undefined) => [...hubspotKeys.all, organizationId] as const,
}

/**
 * Enabled for every role — the backend's GET endpoint only requires
 * organization membership, matching the "member/viewer solo lectura"
 * requirement (they can see connection status, not connect/disconnect).
 */
export function useHubspotConnectionQuery() {
  const { organization } = useOrganization()
  const { session } = useAuth()
  return useQuery({
    queryKey: hubspotKeys.connection(organization?.id),
    queryFn: () => fetchHubspotConnection(session!.access_token, organization!.id),
    enabled: Boolean(organization) && Boolean(session?.access_token),
  })
}

/**
 * Only makes the API call and resolves the HubSpot consent screen URL —
 * deliberately does NOT perform the `window.location.href` navigation
 * itself (a DOM side effect that belongs in the feature/component layer,
 * not an entities/ hook). The caller must navigate the browser there.
 */
export function useConnectHubspotMutation() {
  const { organization } = useOrganization()
  const { session } = useAuth()
  return useMutation({
    mutationFn: () => {
      if (!organization) throw new Error('No hay una organización activa.')
      if (!session?.access_token) throw new Error('No hay una sesión activa.')
      return startHubspotOauth(session.access_token, organization.id)
    },
  })
}

export function useDisconnectHubspotMutation() {
  const { organization } = useOrganization()
  const { session } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => {
      if (!organization) throw new Error('No hay una organización activa.')
      if (!session?.access_token) throw new Error('No hay una sesión activa.')
      return disconnectHubspot(session.access_token, organization.id)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hubspotKeys.connection(organization?.id) }),
  })
}
