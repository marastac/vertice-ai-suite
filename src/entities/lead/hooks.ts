import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { activeLeadRepository } from './active-lead-repository'
import type { CreateLeadInput, UpdateLeadInput } from './lead-repository'

export const leadKeys = {
  all: ['leads'] as const,
  list: () => [...leadKeys.all, 'list'] as const,
}

export function useLeadsQuery() {
  return useQuery({
    queryKey: leadKeys.list(),
    queryFn: () => activeLeadRepository.list(),
  })
}

export function useLeadQuery(id: string | undefined) {
  return useQuery({
    queryKey: leadKeys.list(),
    queryFn: () => activeLeadRepository.list(),
    enabled: Boolean(id),
    select: (leads) => leads.find((lead) => lead.id === id),
  })
}

export function useCreateLeadMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateLeadInput) => activeLeadRepository.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leadKeys.list() }),
  })
}

export function useUpdateLeadMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLeadInput }) =>
      activeLeadRepository.update(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leadKeys.list() }),
  })
}

export function useDeleteLeadMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => activeLeadRepository.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leadKeys.list() }),
  })
}
