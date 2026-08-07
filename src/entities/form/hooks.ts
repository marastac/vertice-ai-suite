import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { leadKeys } from '@/entities/lead'
import { useOrganization } from '@/entities/organization'
import { activeFormRepository } from './active-form-repository'
import { activeSubmissionRepository } from './active-submission-repository'
import { submitQualificationForm } from './submission-service'
import type { CreateFormInput } from './form-repository'
import type { FormBuilderValues, FormStatus } from './schema'
import type { FormSubmissionAnswer, QualificationForm } from './types'

export const formKeys = {
  all: ['forms'] as const,
  list: (organizationId: string | undefined) => [...formKeys.all, 'list', organizationId] as const,
}

export const submissionKeys = {
  all: ['form-submissions'] as const,
  allList: (organizationId: string | undefined) => [...submissionKeys.all, 'all', organizationId] as const,
  byForm: (organizationId: string | undefined, formId: string | undefined) =>
    [...submissionKeys.all, 'by-form', organizationId, formId] as const,
}

export interface QualificationFormWithStats extends QualificationForm {
  submissionCount: number
}

async function fetchFormsWithStats(organizationId: string): Promise<QualificationFormWithStats[]> {
  const [forms, submissions] = await Promise.all([
    activeFormRepository.list(organizationId),
    activeSubmissionRepository.listAll(organizationId),
  ])
  return forms.map((form) => ({
    ...form,
    submissionCount: submissions.filter((submission) => submission.formId === form.id).length,
  }))
}

// Shares one queryFn (and therefore one cache shape) with useFormsQuery under the same
// queryKey — using a different queryFn per hook here would let whichever hook mounts
// first decide the cached shape, silently dropping submissionCount for the other.
export function useFormsQuery() {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: formKeys.list(organization?.id),
    queryFn: () => fetchFormsWithStats(organization!.id),
    enabled: Boolean(organization),
  })
}

/** Authenticated, organization-scoped lookup — for the dashboard (FormBuilderPage, FormSubmissionsPage). For the public /f/:formId page, use usePublicFormQuery instead. */
export function useFormQuery(id: string | undefined) {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: formKeys.list(organization?.id),
    queryFn: () => fetchFormsWithStats(organization!.id),
    enabled: Boolean(id && organization),
    select: (forms) => forms.find((form) => form.id === id),
  })
}

/**
 * Org-agnostic direct lookup by id, for the public (no-login) /f/:formId
 * page — the visitor filling out the form was never a member of any
 * organization, so there's no "active organization" to scope by. See
 * FormRepository.getPublic()'s doc comment for the RLS reasoning.
 */
export function usePublicFormQuery(id: string | undefined) {
  return useQuery({
    queryKey: ['public-form', id],
    queryFn: () => activeFormRepository.getPublic(id as string),
    enabled: Boolean(id),
  })
}

export function useCreateFormMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<CreateFormInput, 'organizationId'>) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeFormRepository.create({ ...input, organizationId: organization.id })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list(organization?.id) }),
  })
}

export function useUpdateFormMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: FormBuilderValues }) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeFormRepository.update(organization.id, id, input)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list(organization?.id) }),
  })
}

export function useDuplicateFormMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeFormRepository.duplicate(organization.id, id)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list(organization?.id) }),
  })
}

export function useSetFormStatusMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: FormStatus }) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeFormRepository.setStatus(organization.id, id, status)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list(organization?.id) }),
  })
}

export function useDeleteFormMutation() {
  const { organization } = useOrganization()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => {
      if (!organization) throw new Error('No hay una organización activa.')
      return activeFormRepository.remove(organization.id, id)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list(organization?.id) }),
  })
}

export function useSubmissionsQuery(formId: string | undefined) {
  const { organization } = useOrganization()
  return useQuery({
    queryKey: submissionKeys.byForm(organization?.id, formId),
    queryFn: () => activeSubmissionRepository.listByForm(organization!.id, formId as string),
    enabled: Boolean(formId && organization),
  })
}

export function useSubmitFormMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ formId, answers }: { formId: string; answers: FormSubmissionAnswer[] }) =>
      submitQualificationForm(formId, answers),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: formKeys.list(result.organizationId) })
      queryClient.invalidateQueries({ queryKey: submissionKeys.byForm(result.organizationId, variables.formId) })
      queryClient.invalidateQueries({ queryKey: leadKeys.list(result.organizationId) })
    },
  })
}
