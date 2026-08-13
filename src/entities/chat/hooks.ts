import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOrganization } from '@/entities/organization'
import { activeChatConfigRepository } from './active-chat-config-repository'
import { activeChatSessionRepository } from './active-chat-session-repository'
import { checkBackendHealth } from './api-client'
import type { ChatConfiguration } from './types'

export const chatConfigKeys = {
  all: (organizationId: string | undefined) => ['chat-config', organizationId] as const,
}

export function useChatConfigQuery() {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: chatConfigKeys.all(organization?.id),
    queryFn: () => activeChatConfigRepository.get(organization!.id),
    enabled: Boolean(organization),
  })
}

/** Org-agnostic lookup by public org slug, for the public (no-login) /c/:orgSlug page. See ChatConfigRepository.getBySlug()'s doc comment. */
export function usePublicChatConfigQuery(orgSlug: string | undefined) {
  return useQuery({
    queryKey: ['public-chat-config', orgSlug],
    queryFn: () => activeChatConfigRepository.getBySlug(orgSlug as string),
    enabled: Boolean(orgSlug),
  })
}

/** Callers pass everything except organizationId — the mutation injects the caller's active organization automatically. */
export function useSaveChatConfigMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (config: Omit<ChatConfiguration, 'organizationId'>) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeChatConfigRepository.save(organization.id, { ...config, organizationId: organization.id })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatConfigKeys.all(organization?.id) }),
  })
}

export function useResetChatConfigMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeChatConfigRepository.reset(organization.id)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatConfigKeys.all(organization?.id) }),
  })
}

export const chatSessionKeys = {
  all: ['chat-sessions'] as const,
  list: (organizationId: string | undefined) => [...chatSessionKeys.all, 'list', organizationId] as const,
  byId: (organizationId: string | undefined, id: string | undefined) =>
    [...chatSessionKeys.all, 'byId', organizationId, id] as const,
}

/**
 * Chat sessions/messages are organization-scoped rows in Postgres (see
 * supabase/schema.sql's chat_sessions/chat_messages) — a real cross-device
 * listing, not a per-browser localStorage mirror. organizationId is
 * injected here the same way every other entity's hooks do it (see
 * entities/lead/hooks.ts), so this always reflects the signed-in member's
 * own organization, enforced again server-side by chat_sessions_select's
 * is_org_member RLS policy.
 */
export function useChatSessionsQuery() {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: chatSessionKeys.list(organization?.id),
    queryFn: () => activeChatSessionRepository.list(organization!.id),
    enabled: Boolean(organization),
  })
}

export function useBackendHealthQuery() {
  return useQuery({
    queryKey: ['backend-health'],
    queryFn: () => checkBackendHealth(),
    retry: false,
    staleTime: 15_000,
  })
}

export function useChatSessionQuery(id: string | undefined) {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: chatSessionKeys.byId(organization?.id, id),
    queryFn: () => activeChatSessionRepository.get(organization!.id, id!),
    enabled: Boolean(organization && id),
  })
}
