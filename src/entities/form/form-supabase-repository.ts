import { supabase } from '@/shared/lib/supabase-client'
import type { FormRepository } from './form-repository'
import { isPossibleFormId, publicFormFromRow } from './public-form'
import type { PublicFormRow } from './public-form'
import type { FormStatus } from './schema'
import type { FormQuestion, QualificationForm } from './types'

interface FormRow {
  id: string
  organization_id: string
  name: string
  description: string | null
  status: FormStatus
  questions: FormQuestion[]
  created_at: string
  updated_at: string
}

function fromRow(row: FormRow): QualificationForm {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    questions: row.questions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const supabaseFormRepository: FormRepository = {
  async list(organizationId) {
    const { data, error } = await supabase
      .from('forms')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  async get(organizationId, id) {
    const { data, error } = await supabase
      .from('forms')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return data ? fromRow(data) : undefined
  },

  async getPublic(id) {
    // Deliberately no organization_id filter — see the interface doc
    // comment in form-repository.ts. Reads through the get_public_form()
    // RPC: `forms` itself is members-only since
    // supabase/migrations-public-read-hardening.sql, and the RPC returns
    // ACTIVE forms only, without their scoring.
    if (!isPossibleFormId(id)) return undefined
    const { data, error } = await supabase.rpc('get_public_form', { p_form_id: id }).maybeSingle()
    if (error) throw error
    return data ? publicFormFromRow(data as PublicFormRow) : undefined
  },

  async create(input) {
    const { data, error } = await supabase
      .from('forms')
      .insert({
        organization_id: input.organizationId,
        name: input.name,
        description: input.description ?? null,
        status: input.status,
        questions: input.questions,
      })
      .select('*')
      .single()
    if (error) throw error
    return fromRow(data)
  },

  async update(organizationId, id, input) {
    const { data, error } = await supabase
      .from('forms')
      .update({
        name: input.name,
        description: input.description ?? null,
        status: input.status,
        questions: input.questions,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw error
    return fromRow(data)
  },

  async duplicate(organizationId, id) {
    const original = await supabaseFormRepository.get(organizationId, id)
    if (!original) {
      throw new Error(`No se encontró el formulario ${id}.`)
    }

    const { data, error } = await supabase
      .from('forms')
      .insert({
        organization_id: organizationId,
        name: `${original.name} (copia)`,
        description: original.description ?? null,
        status: 'draft',
        questions: original.questions.map((question) => ({
          ...question,
          id: crypto.randomUUID(),
          options: question.options?.map((option) => ({ ...option, id: crypto.randomUUID() })),
        })),
      })
      .select('*')
      .single()
    if (error) throw error
    return fromRow(data)
  },

  async setStatus(organizationId, id, status) {
    const { data, error } = await supabase
      .from('forms')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('organization_id', organizationId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw error
    return fromRow(data)
  },

  async remove(organizationId, id) {
    const { error } = await supabase.from('forms').delete().eq('organization_id', organizationId).eq('id', id)
    if (error) throw error
  },
}
