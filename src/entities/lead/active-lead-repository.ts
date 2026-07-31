import { dataBackend } from '@/shared/lib/data-backend'
import { localStorageLeadRepository } from './lead-repository'
import { supabaseLeadRepository } from './lead-supabase-repository'
import type { LeadRepository } from './lead-repository'

/** Which LeadRepository implementation is live, selected once by VITE_DATA_BACKEND. */
export const activeLeadRepository: LeadRepository =
  dataBackend === 'supabase' ? supabaseLeadRepository : localStorageLeadRepository
