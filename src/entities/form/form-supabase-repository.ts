import { supabase } from '@/shared/lib/supabase-client'
import type { FormRepository } from './form-repository'
import type { FormStatus } from './schema'
import type { FormQuestion, QualificationForm } from './types'

interface FormRow {
  id: string
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
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    questions: row.questions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const supabaseFormRepository: FormRepository = {
  async list() {
    const { data, error } = await supabase.from('forms').select('*').order('created_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  async get(id) {
    const { data, error } = await supabase.from('forms').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    return data ? fromRow(data) : undefined
  },

  async create(input) {
    const { data, error } = await supabase
      .from('forms')
      .insert({
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

  async update(id, input) {
    const { data, error } = await supabase
      .from('forms')
      .update({
        name: input.name,
        description: input.description ?? null,
        status: input.status,
        questions: input.questions,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw error
    return fromRow(data)
  },

  async duplicate(id) {
    const original = await supabaseFormRepository.get(id)
    if (!original) {
      throw new Error(`No se encontró el formulario ${id}.`)
    }

    const { data, error } = await supabase
      .from('forms')
      .insert({
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

  async setStatus(id, status) {
    const { data, error } = await supabase
      .from('forms')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw error
    return fromRow(data)
  },

  async remove(id) {
    const { error } = await supabase.from('forms').delete().eq('id', id)
    if (error) throw error
  },
}
