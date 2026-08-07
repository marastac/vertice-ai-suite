import { dataBackend } from '@/shared/lib/data-backend'
import { localOrganizationRepository } from './organization-repository'
import { supabaseOrganizationRepository } from './organization-supabase-repository'
import type { OrganizationRepository } from './organization-repository'

/** Which OrganizationRepository implementation is live, selected once by VITE_DATA_BACKEND. */
export const activeOrganizationRepository: OrganizationRepository =
  dataBackend === 'supabase' ? supabaseOrganizationRepository : localOrganizationRepository
