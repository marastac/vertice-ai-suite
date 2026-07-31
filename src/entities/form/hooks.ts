import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { leadKeys } from '@/entities/lead'
import { activeFormRepository } from './active-form-repository'
import { activeSubmissionRepository } from './active-submission-repository'
import { submitQualificationForm } from './submission-service'
import type { FormBuilderValues, FormStatus } from './schema'
import type { FormSubmissionAnswer, QualificationForm } from './types'

export const formKeys = {
  all: ['forms'] as const,
  list: () => [...formKeys.all, 'list'] as const,
}

export const submissionKeys = {
  all: ['form-submissions'] as const,
  allList: () => [...submissionKeys.all, 'all'] as const,
  byForm: (formId: string | undefined) => [...submissionKeys.all, 'by-form', formId] as const,
}

export interface QualificationFormWithStats extends QualificationForm {
  submissionCount: number
}

async function fetchFormsWithStats(): Promise<QualificationFormWithStats[]> {
  const [forms, submissions] = await Promise.all([
    activeFormRepository.list(),
    activeSubmissionRepository.listAll(),
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
  return useQuery({
    queryKey: formKeys.list(),
    queryFn: fetchFormsWithStats,
  })
}

export function useFormQuery(id: string | undefined) {
  return useQuery({
    queryKey: formKeys.list(),
    queryFn: fetchFormsWithStats,
    enabled: Boolean(id),
    select: (forms) => forms.find((form) => form.id === id),
  })
}

export function useCreateFormMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: FormBuilderValues) => activeFormRepository.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

export function useUpdateFormMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: FormBuilderValues }) => activeFormRepository.update(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

export function useDuplicateFormMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => activeFormRepository.duplicate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

export function useSetFormStatusMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: FormStatus }) => activeFormRepository.setStatus(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

export function useDeleteFormMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => activeFormRepository.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

export function useSubmissionsQuery(formId: string | undefined) {
  return useQuery({
    queryKey: submissionKeys.byForm(formId),
    queryFn: () => activeSubmissionRepository.listByForm(formId as string),
    enabled: Boolean(formId),
  })
}

export function useSubmitFormMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ formId, answers }: { formId: string; answers: FormSubmissionAnswer[] }) =>
      submitQualificationForm(formId, answers),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: formKeys.list() })
      queryClient.invalidateQueries({ queryKey: submissionKeys.byForm(variables.formId) })
      queryClient.invalidateQueries({ queryKey: leadKeys.list() })
    },
  })
}
