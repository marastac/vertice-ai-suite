export type ChatTone = 'professional' | 'friendly' | 'concise' | 'consultative'

export interface QualificationCriterion {
  id: string
  label: string
  points: number
}

export interface ChatConfiguration {
  assistantName: string
  welcomeMessage: string
  agencyDescription: string
  servicesOffered: string
  tone: ChatTone
  language: string
  questionsToCollect: string[]
  criteria: QualificationCriterion[]
  minQualifiedScore: number
  additionalInstructions?: string
  isActive: boolean
  updatedAt: string
}

export type ChatMessageRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatMessageRole
  content: string
  createdAt: string
}

export type ChatQualificationStatus = 'disqualified' | 'qualifying' | 'qualified'

export interface ChatQualificationResult {
  contactName: string | null
  email: string | null
  phone: string | null
  company: string | null
  businessType: string | null
  requestedService: string | null
  budget: string | null
  timeline: string | null
  mainNeed: string | null
  summary: string
  score: number
  status: ChatQualificationStatus
  reasons: string[]
  collectedFields: string[]
  missingFields: string[]
  conversationComplete: boolean
}

export interface ChatSession {
  id: string
  orgSlug: string
  assistantName: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
  qualification?: ChatQualificationResult
  leadId?: string
}
