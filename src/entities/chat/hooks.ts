import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { activeChatConfigRepository } from './active-chat-config-repository'
import { checkBackendHealth } from './api-client'
import { localStorageChatSessionRepository } from './chat-session-repository'
import type { ChatConfiguration } from './types'

export const chatConfigKeys = {
  all: ['chat-config'] as const,
}

export function useChatConfigQuery() {
  return useQuery({
    queryKey: chatConfigKeys.all,
    queryFn: () => activeChatConfigRepository.get(),
  })
}

export function useSaveChatConfigMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (config: ChatConfiguration) => activeChatConfigRepository.save(config),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatConfigKeys.all }),
  })
}

export function useResetChatConfigMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => activeChatConfigRepository.reset(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatConfigKeys.all }),
  })
}

export const chatSessionKeys = {
  all: ['chat-sessions'] as const,
  list: () => [...chatSessionKeys.all, 'list'] as const,
}

export function useChatSessionsQuery() {
  return useQuery({
    queryKey: chatSessionKeys.list(),
    queryFn: () => localStorageChatSessionRepository.list(),
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
    queryKey: chatSessionKeys.list(),
    queryFn: () => localStorageChatSessionRepository.list(),
    enabled: Boolean(id),
    select: (sessions) => sessions.find((session) => session.id === id),
  })
}
