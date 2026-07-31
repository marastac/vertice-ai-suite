import { dataBackend } from '@/shared/lib/data-backend'
import { localStorageSubmissionRepository } from './submission-repository'
import { supabaseSubmissionRepository } from './submission-supabase-repository'
import type { SubmissionRepository } from './submission-repository'

/** Which SubmissionRepository implementation is live, selected once by VITE_DATA_BACKEND. */
export const activeSubmissionRepository: SubmissionRepository =
  dataBackend === 'supabase' ? supabaseSubmissionRepository : localStorageSubmissionRepository
