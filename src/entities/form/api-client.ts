import type { FormSubmissionAnswer } from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787'

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null)
  return (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error) || fallback
}

export interface SubmitPublicFormResponse {
  submissionId: string
  leadId: string
  organizationId: string
  score: number
  status: string
  submittedAt: string
}

/**
 * Used ONLY on the `supabase` data backend (see submission-service.ts) —
 * this is the Fase C hardening replacing what used to be a direct,
 * unauthenticated Supabase write from the browser (leads/form_submissions/
 * lead_activity). The backend loads the real form, validates `answers`
 * against it, and computes `score`/`status` itself — nothing here is an
 * authority value the client controls, see server/src/schemas/forms.ts's
 * `.strict()` schemas and server/src/services/form-submission-service.ts.
 *
 * `honeypot` is a hidden field a real visitor never sees or fills (see
 * PublicFormPage.tsx) — sent as `website` to match the backend's own field
 * name for it. A filled value causes the backend to silently discard the
 * submission while still returning a normal-looking success response.
 */
export async function submitPublicForm(
  formId: string,
  answers: FormSubmissionAnswer[],
  honeypot: string,
): Promise<SubmitPublicFormResponse> {
  const response = await fetch(`${API_BASE_URL}/api/forms/${formId}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers, website: honeypot }),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo enviar el formulario. Inténtalo de nuevo.'))
  }

  return response.json()
}
