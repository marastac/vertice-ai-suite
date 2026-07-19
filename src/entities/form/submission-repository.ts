import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import type { FormSubmission, FormSubmissionAnswer } from './types'

const STORAGE_KEY = 'lead-ai:form-submissions:v1'

export interface CreateSubmissionInput {
  id?: string
  formId: string
  answers: FormSubmissionAnswer[]
  score: number
  leadId?: string
  submittedAt?: string
}

export interface SubmissionRepository {
  listAll(): Promise<FormSubmission[]>
  listByForm(formId: string): Promise<FormSubmission[]>
  create(input: CreateSubmissionInput): Promise<FormSubmission>
}

function readSubmissions(): FormSubmission[] {
  return readJSON<FormSubmission[]>(STORAGE_KEY, [])
}

function writeSubmissions(submissions: FormSubmission[]): void {
  writeJSON(STORAGE_KEY, submissions)
}

export const localStorageSubmissionRepository: SubmissionRepository = {
  async listAll() {
    return readSubmissions()
  },

  async listByForm(formId) {
    return readSubmissions().filter((submission) => submission.formId === formId)
  },

  async create(input) {
    const submissions = readSubmissions()
    const submission: FormSubmission = {
      id: input.id ?? crypto.randomUUID(),
      formId: input.formId,
      answers: input.answers,
      score: input.score,
      leadId: input.leadId,
      submittedAt: input.submittedAt ?? new Date().toISOString(),
    }
    writeSubmissions([submission, ...submissions])
    return submission
  },
}
