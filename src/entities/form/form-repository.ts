import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { mockForms } from './mock-data'
import type { FormBuilderValues, FormStatus } from './schema'
import type { QualificationForm } from './types'

const STORAGE_KEY = 'lead-ai:forms:v1'

export type CreateFormInput = FormBuilderValues & { organizationId: string }

export interface FormRepository {
  list(organizationId: string): Promise<QualificationForm[]>
  get(organizationId: string, id: string): Promise<QualificationForm | undefined>
  /**
   * Org-agnostic direct lookup by id, for the public (no-login) /f/:formId
   * page — a visitor filling out a form was never a member of any
   * organization, so there's no organizationId to filter by yet. Relies on
   * `forms`' SELECT policy staying public in Supabase (see schema.sql's
   * multi-tenancy note); the returned row's organizationId is what
   * submission-service.ts then uses to create the resulting Lead. Every
   * other method on this interface IS organization-scoped — this is the
   * one deliberate exception.
   */
  getPublic(id: string): Promise<QualificationForm | undefined>
  create(input: CreateFormInput): Promise<QualificationForm>
  update(organizationId: string, id: string, input: FormBuilderValues): Promise<QualificationForm>
  duplicate(organizationId: string, id: string): Promise<QualificationForm>
  setStatus(organizationId: string, id: string, status: FormStatus): Promise<QualificationForm>
  remove(organizationId: string, id: string): Promise<void>
}

function readForms(): QualificationForm[] {
  const stored = readJSON<QualificationForm[] | null>(STORAGE_KEY, null)
  if (stored) return stored
  writeJSON(STORAGE_KEY, mockForms)
  return [...mockForms]
}

function writeForms(forms: QualificationForm[]): void {
  writeJSON(STORAGE_KEY, forms)
}

export const localStorageFormRepository: FormRepository = {
  async list(organizationId) {
    return readForms().filter((form) => form.organizationId === organizationId)
  },

  async get(organizationId, id) {
    return readForms().find((form) => form.id === id && form.organizationId === organizationId)
  },

  async getPublic(id) {
    return readForms().find((form) => form.id === id)
  },

  async create(input) {
    const forms = readForms()
    const now = new Date().toISOString()
    const form: QualificationForm = {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      description: input.description,
      status: input.status,
      questions: input.questions,
      createdAt: now,
      updatedAt: now,
    }
    writeForms([form, ...forms])
    return form
  },

  async update(organizationId, id, input) {
    const forms = readForms()
    const index = forms.findIndex((form) => form.id === id && form.organizationId === organizationId)
    if (index === -1) {
      throw new Error(`No se encontró el formulario ${id}.`)
    }

    const updated: QualificationForm = {
      ...forms[index],
      name: input.name,
      description: input.description,
      status: input.status,
      questions: input.questions,
      updatedAt: new Date().toISOString(),
    }
    forms[index] = updated
    writeForms(forms)
    return updated
  },

  async duplicate(organizationId, id) {
    const forms = readForms()
    const original = forms.find((form) => form.id === id && form.organizationId === organizationId)
    if (!original) {
      throw new Error(`No se encontró el formulario ${id}.`)
    }

    const now = new Date().toISOString()
    const copy: QualificationForm = {
      ...original,
      id: crypto.randomUUID(),
      name: `${original.name} (copia)`,
      status: 'draft',
      questions: original.questions.map((question) => ({
        ...question,
        id: crypto.randomUUID(),
        options: question.options?.map((option) => ({ ...option, id: crypto.randomUUID() })),
      })),
      createdAt: now,
      updatedAt: now,
    }
    writeForms([copy, ...forms])
    return copy
  },

  async setStatus(organizationId, id, status) {
    const forms = readForms()
    const index = forms.findIndex((form) => form.id === id && form.organizationId === organizationId)
    if (index === -1) {
      throw new Error(`No se encontró el formulario ${id}.`)
    }

    const updated: QualificationForm = { ...forms[index], status, updatedAt: new Date().toISOString() }
    forms[index] = updated
    writeForms(forms)
    return updated
  },

  async remove(organizationId, id) {
    const forms = readForms()
    writeForms(forms.filter((form) => !(form.id === id && form.organizationId === organizationId)))
  },
}
