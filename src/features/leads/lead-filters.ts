export type LeadSortOption = 'newest' | 'oldest' | 'score-desc' | 'score-asc'

export interface LeadFilters {
  search: string
  status: string
  source: string
  assignedTo: string
  scoreMin: string
  scoreMax: string
  sort: LeadSortOption
}

export const defaultLeadFilters: LeadFilters = {
  search: '',
  status: 'all',
  source: 'all',
  assignedTo: 'all',
  scoreMin: '',
  scoreMax: '',
  sort: 'newest',
}
