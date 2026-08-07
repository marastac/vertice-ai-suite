import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOrganization } from '@/entities/organization'
import { activeLeadRepository } from './active-lead-repository'
import type { CreateLeadInput, UpdateLeadInput } from './lead-repository'

export const leadKeys = {
  all: ['leads'] as const,
  list: (organizationId: string | undefined) => [...leadKeys.all, 'list', organizationId] as const,
}

export function useLeadsQuery() {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: leadKeys.list(organization?.id),
    queryFn: () => activeLeadRepository.list(organization!.id),
    enabled: Boolean(organization),
  })
}

export function useLeadQuery(id: string | undefined) {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: leadKeys.list(organization?.id),
    queryFn: () => activeLeadRepository.list(organization!.id),
    enabled: Boolean(id && organization),
    select: (leads) => leads.find((lead) => lead.id === id),
  })
}

/** Callers pass everything except organizationId — the mutation injects the caller's active organization automatically. */
export function useCreateLeadMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<CreateLeadInput, 'organizationId'>) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeLeadRepository.create({ ...input, organizationId: organization.id })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leadKeys.list(organization?.id) }),
  })
}

export function useUpdateLeadMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLeadInput }) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeLeadRepository.update(organization.id, id, patch)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leadKeys.list(organization?.id) }),
  })
}

export function useDeleteLeadMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeLeadRepository.remove(organization.id, id)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leadKeys.list(organization?.id) }),
  })
}
