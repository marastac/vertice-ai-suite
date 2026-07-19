import { readJSON, writeJSON } from '@/shared/lib/local-storage'
import { mockForms } from './mock-data'
import type { FormBuilderValues, FormStatus } from './schema'
import type { QualificationForm } from './types'

const STORAGE_KEY = 'lead-ai:forms:v1'

export interface FormRepository {
  list(): Promise<QualificationForm[]>
  get(id: string): Promise<QualificationForm | undefined>
  create(input: FormBuilderValues): Promise<QualificationForm>
  update(id: string, input: FormBuilderValues): Promise<QualificationForm>
  duplicate(id: string): Promise<QualificationForm>
  setStatus(id: string, status: FormStatus): Promise<QualificationForm>
  remove(id: string): Promise<void>
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
  async list() {
    return readForms()
  },

  async get(id) {
    return readForms().find((form) => form.id === id)
  },

  async create(input) {
    const forms = readForms()
    const now = new Date().toISOString()
    const form: QualificationForm = {
      id: crypto.randomUUID(),
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

  async update(id, input) {
    const forms = readForms()
    const index = forms.findIndex((form) => form.id === id)
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

  async duplicate(id) {
    const forms = readForms()
    const original = forms.find((form) => form.id === id)
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

  async setStatus(id, status) {
    const forms = readForms()
    const index = forms.findIndex((form) => form.id === id)
    if (index === -1) {
      throw new Error(`No se encontró el formulario ${id}.`)
    }

    const updated: QualificationForm = { ...forms[index], status, updatedAt: new Date().toISOString() }
    forms[index] = updated
    writeForms(forms)
    return updated
  },

  async remove(id) {
    const forms = readForms()
    writeForms(forms.filter((form) => form.id !== id))
  },
}
