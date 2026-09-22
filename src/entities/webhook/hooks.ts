import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/entities/auth'
import { useOrganization } from '@/entities/organization'
import { fetchWebhookConfig, saveWebhookConfig, testWebhook } from './api-client'
import type { SaveWebhookConfigParams } from './api-client'

export const webhookKeys = {
  all: ['webhook-config'] as const,
  config: (organizationId: string | undefined) => [...webhookKeys.all, organizationId] as const,
}

/**
 * Enabled for every role — the backend's GET endpoint only requires
 * organization membership, matching the "member/viewer solo lectura"
 * requirement (they can see the config, not edit/test it).
 */
export function useWebhookConfigQuery() {
  const { organization } = useOrganization()
  const { session } = useAuth()
  return useQuery({
    queryKey: webhookKeys.config(organization?.id),
    queryFn: () => fetchWebhookConfig(session!.access_token, organization!.id),
    enabled: Boolean(organization) && Boolean(session?.access_token),
  })
}

/** Callers pass everything except organizationId — injected from the active organization, same pattern as every other mutation hook in this app. */
export function useSaveWebhookConfigMutation() {
  const { organization } = useOrganization()
  const { session } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<SaveWebhookConfigParams, 'organizationId'>) => {
      if (!organization) throw new Error('No hay una organización activa.')
      if (!session?.access_token) throw new Error('No hay una sesión activa.')
      return saveWebhookConfig(session.access_token, { ...input, organizationId: organization.id })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: webhookKeys.config(organization?.id) }),
  })
}

export function useTestWebhookMutation() {
  const { organization } = useOrganization()
  const { session } = useAuth()
  return useMutation({
    mutationFn: () => {
      if (!organization) throw new Error('No hay una organización activa.')
      if (!session?.access_token) throw new Error('No hay una sesión activa.')
      return testWebhook(session.access_token, organization.id)
    },
  })
}
