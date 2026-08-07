import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOrganization } from '@/entities/organization'
import { activeChatConfigRepository } from './active-chat-config-repository'
import { checkBackendHealth } from './api-client'
import { localStorageChatSessionRepository } from './chat-session-repository'
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
  list: (orgSlug: string | undefined) => [...chatSessionKeys.all, 'list', orgSlug] as const,
}

/**
 * Chat sessions still live only in this browser's localStorage (see
 * CLAUDE.md's "Phase 8" section for why they weren't moved to Postgres this
 * phase) — filtering by the active organization's slug here is about
 * display hygiene (a browser used to test more than one organization's
 * public chat shouldn't blend their conversations together in
 * /conversations), not security isolation, since this data was never
 * shared across browsers/users to begin with.
 */
export function useChatSessionsQuery() {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: chatSessionKeys.list(organization?.slug),
    queryFn: async () => {
      const sessions = await localStorageChatSessionRepository.list()
      return sessions.filter((session) => session.orgSlug === organization?.slug)
    },
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
  return useQuery({
    queryKey: [...chatSessionKeys.all, 'byId', id],
    queryFn: () => localStorageChatSessionRepository.list(),
    enabled: Boolean(id),
    select: (sessions) => sessions.find((session) => session.id === id),
  })
}
