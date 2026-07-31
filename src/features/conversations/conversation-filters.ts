export type ConversationStatusFilter = 'all' | 'pending' | 'disqualified' | 'qualifying' | 'qualified'

export interface ConversationFilters {
  search: string
  status: ConversationStatusFilter
}

export const defaultConversationFilters: ConversationFilters = {
  search: '',
  status: 'all',
}
