import type { LeadSource, LeadStatus } from './schema'

export interface LeadActivityEntry {
  id: string
  message: string
  createdAt: string
}

export interface Lead {
  id: string
  name: string
  email: string
  phone?: string
  company: string
  position?: string
  source: LeadSource
  status: LeadStatus
  score: number
  estimatedBudget?: number
  assignedTo?: string
  notes?: string
  createdAt: string
  lastActivityAt: string
  activity: LeadActivityEntry[]
  formId?: string
  submissionId?: string
}
