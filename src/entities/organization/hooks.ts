import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/entities/auth'
import { activeOrganizationRepository } from './active-organization-repository'
import { useOrganization } from './use-organization'
import type { CreateInviteInput } from './organization-repository'

export const organizationInviteKeys = {
  all: ['organization-invites'] as const,
  list: (organizationId: string | undefined) => [...organizationInviteKeys.all, 'list', organizationId] as const,
  preview: (token: string) => [...organizationInviteKeys.all, 'preview', token] as const,
}

export function useInvitesQuery() {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: organizationInviteKeys.list(organization?.id),
    queryFn: () => activeOrganizationRepository.listInvites(organization!.id),
    enabled: Boolean(organization),
  })
}

/** Callers pass everything except organizationId/invitedBy — the mutation injects the active organization and signed-in user automatically. */
export function useCreateInviteMutation() {
  const { organization } = useOrganization()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<CreateInviteInput, 'organizationId' | 'invitedBy'>) => {
      if (!organization) throw new Error('No hay una organización activa.')
      if (!user) throw new Error('No hay un usuario autenticado.')
      return activeOrganizationRepository.createInvite({ ...input, organizationId: organization.id, invitedBy: user.id })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: organizationInviteKeys.list(organization?.id) }),
  })
}

export function useRevokeInviteMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (inviteId: string) => activeOrganizationRepository.revokeInvite(inviteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: organizationInviteKeys.list(organization?.id) }),
  })
}

/** Public preview by token — never injects the active organization, since the caller may not be a member of anything yet. */
export function useInvitePreviewQuery(token: string | undefined) {
  return useQuery({
    queryKey: organizationInviteKeys.preview(token ?? ''),
    queryFn: () => activeOrganizationRepository.getInviteByToken(token!),
    enabled: Boolean(token),
  })
}

export function useAcceptInviteMutation() {
  return useMutation({
    mutationFn: (token: string) => activeOrganizationRepository.acceptInvite(token),
  })
}
