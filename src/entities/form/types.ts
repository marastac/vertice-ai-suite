import type { FormStatus, QuestionType } from './schema'

export interface QuestionOption {
  id: string
  label: string
  points: number
}

export interface FormQuestion {
  id: string
  type: QuestionType
  label: string
  required: boolean
  points?: number
  options?: QuestionOption[]
}

export interface QualificationForm {
  id: string
  organizationId: string
  name: string
  description?: string
  status: FormStatus
  questions: FormQuestion[]
  createdAt: string
  updatedAt: string
}

export interface FormSubmissionAnswer {
  questionId: string
  value: string | string[]
}

export interface FormSubmission {
  id: string
  organizationId: string
  formId: string
  answers: FormSubmissionAnswer[]
  score: number
  leadId?: string
  submittedAt: string
}
