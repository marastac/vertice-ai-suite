import type { FormStatus } from './schema'
import type { FormQuestion, QualificationForm } from './types'

/** Row returned by the `get_public_form(p_form_id)` RPC: active forms only, with every `points` removed. */
export interface PublicFormRow {
  id: string
  organization_id: string
  name: string
  description: string | null
  status: FormStatus
  questions: Array<Omit<FormQuestion, 'points' | 'options'> & { options?: Array<{ id: string; label: string }> }>
  created_at: string
  updated_at: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A form id from the URL that can't be a real form id is simply "not found" — never sent to the database. */
export function isPossibleFormId(id: string): boolean {
  return UUID_PATTERN.test(id)
}

/**
 * Maps the public RPC row to the app's form shape. The scoring (`points`) is
 * deliberately absent from the public row (supabase/
 * migrations-public-read-hardening.sql): on the Supabase backend the score
 * is computed by the server (server/src/services/form-submission-service.ts),
 * so the public page never needs it. Options get `points: 0` only to satisfy
 * the shared type.
 *
 * Kept free of the Supabase client so it can be unit-tested directly
 * (tests/public-read-mappers.test.ts).
 */
export function publicFormFromRow(row: PublicFormRow): QualificationForm {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    questions: row.questions.map(({ options, ...question }) => ({
      ...question,
      ...(options ? { options: options.map((option) => ({ id: option.id, label: option.label, points: 0 })) } : {}),
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
