import { dataBackend } from '@/shared/lib/data-backend'
import { localStorageFormRepository } from './form-repository'
import { supabaseFormRepository } from './form-supabase-repository'
import type { FormRepository } from './form-repository'

/** Which FormRepository implementation is live, selected once by VITE_DATA_BACKEND. */
export const activeFormRepository: FormRepository =
  dataBackend === 'supabase' ? supabaseFormRepository : localStorageFormRepository
