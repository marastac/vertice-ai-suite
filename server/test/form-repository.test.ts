import { afterEach, describe, expect, it, vi } from 'vitest'

// loadPublicForm() is the backend's own server-side source of truth for a
// public form's real organization_id/status/questions — used to stop a
// public form submission's lead/score/organization attribution from ever
// depending on anything the client sends (see the Fase C implementation
// report). Same three-state shape as organization-lookup.ts/
// chat-config-repository.ts, and the same 5s .abortSignal(AbortSignal.timeout(...))
// mechanism — none of these tests wait a real 5 seconds.

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../src/lib/supabase-client.js')
  vi.doUnmock('../src/lib/logger.js')
})

function mockSupabaseFormQuery(result: { data: Record<string, unknown> | null; error: { message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const abortSignal = vi.fn().mockReturnValue({ maybeSingle })
  const eq = vi.fn().mockReturnValue({ abortSignal })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
  return { from, select, eq, maybeSingle, abortSignal }
}

const FIXTURE_ROW = {
  id: 'form-real-uuid',
  organization_id: 'org-real-uuid',
  name: 'Formulario de calificación',
  status: 'active',
  questions: [{ id: 'q1', type: 'email', label: 'Correo', required: true }],
}

describe('loadPublicForm', () => {
  it('returns { status: "found", form } mapped from the real row', async () => {
    const { from, eq } = mockSupabaseFormQuery({ data: FIXTURE_ROW, error: null })
    const { loadPublicForm } = await import('../src/repositories/form-repository.js')

    const result = await loadPublicForm('form-real-uuid')

    expect(from).toHaveBeenCalledWith('forms')
    expect(eq).toHaveBeenCalledWith('id', 'form-real-uuid')
    expect(result).toEqual({
      status: 'found',
      form: {
        id: 'form-real-uuid',
        organizationId: 'org-real-uuid',
        name: 'Formulario de calificación',
        status: 'active',
        questions: FIXTURE_ROW.questions,
      },
    })
  })

  it('returns { status: "not_found" } when the query succeeds but no form matches this id', async () => {
    mockSupabaseFormQuery({ data: null, error: null })
    const { loadPublicForm } = await import('../src/repositories/form-repository.js')

    await expect(loadPublicForm('nonexistent-form-id')).resolves.toEqual({ status: 'not_found' })
  })

  it('returns { status: "unavailable" } (never "not_found") when the query itself fails', async () => {
    mockSupabaseFormQuery({ data: null, error: { message: 'connection error' } })
    const { loadPublicForm } = await import('../src/repositories/form-repository.js')

    await expect(loadPublicForm('form-real-uuid')).resolves.toEqual({ status: 'unavailable' })
  })

  it('applies a 5000ms timeout via the native AbortSignal.timeout() mechanism', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { abortSignal } = mockSupabaseFormQuery({ data: FIXTURE_ROW, error: null })
    const { loadPublicForm } = await import('../src/repositories/form-repository.js')

    await loadPublicForm('form-real-uuid')

    expect(timeoutSpy).toHaveBeenCalledWith(5000)
    expect(abortSignal).toHaveBeenCalledWith(timeoutSpy.mock.results[0]?.value)
    timeoutSpy.mockRestore()
  })

  it('classifies a simulated query timeout/abort as "unavailable", never "not_found"', async () => {
    mockSupabaseFormQuery({ data: null, error: { message: 'FetchError: The user aborted a request.' } })
    const { loadPublicForm } = await import('../src/repositories/form-repository.js')

    const result = await loadPublicForm('form-real-uuid')
    expect(result.status).toBe('unavailable')
    expect(result.status).not.toBe('not_found')
  })

  it('returns { status: "unavailable" } when supabaseAdmin is null', async () => {
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: null }))
    const { loadPublicForm } = await import('../src/repositories/form-repository.js')

    await expect(loadPublicForm('form-real-uuid')).resolves.toEqual({ status: 'unavailable' })
  })
})

describe('insertLead / insertLeadActivity / insertFormSubmission', () => {
  it('insertLead writes exactly the given fields, snake_cased, with source: "form"', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
    const { insertLead } = await import('../src/repositories/form-repository.js')

    await insertLead({
      organizationId: 'org-1',
      name: 'Ana',
      email: 'ana@example.com',
      phone: '555',
      company: 'Acme',
      score: 80,
      status: 'qualified',
      notes: 'nota',
      formId: 'form-1',
      submissionId: 'submission-1',
    })

    expect(from).toHaveBeenCalledWith('leads')
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        name: 'Ana',
        email: 'ana@example.com',
        phone: '555',
        company: 'Acme',
        source: 'form',
        status: 'qualified',
        score: 80,
        notes: 'nota',
        form_id: 'form-1',
        submission_id: 'submission-1',
      }),
    )
  })

  it('insertLead throws (never swallows) when the insert fails', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'insert failed' } })
    const from = vi.fn().mockReturnValue({ insert })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
    const { insertLead } = await import('../src/repositories/form-repository.js')

    await expect(
      insertLead({
        organizationId: 'org-1',
        name: 'Ana',
        email: 'ana@example.com',
        company: 'Acme',
        score: 0,
        status: 'disqualified',
        notes: '',
        formId: 'form-1',
        submissionId: 'submission-1',
      }),
    ).rejects.toBeTruthy()
  })

  it('insertLeadActivity writes organization_id/lead_id/message', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
    const { insertLeadActivity } = await import('../src/repositories/form-repository.js')

    await insertLeadActivity('org-1', 'lead-1', 'Lead creado automáticamente desde un formulario.')

    expect(from).toHaveBeenCalledWith('lead_activity')
    expect(insert).toHaveBeenCalledWith({
      organization_id: 'org-1',
      lead_id: 'lead-1',
      message: 'Lead creado automáticamente desde un formulario.',
    })
  })

  it('insertFormSubmission writes the answers/score/lead_id', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ insert })
    vi.doMock('../src/lib/supabase-client.js', () => ({ supabaseAdmin: { from } }))
    const { insertFormSubmission } = await import('../src/repositories/form-repository.js')

    await insertFormSubmission({
      id: 'submission-1',
      organizationId: 'org-1',
      formId: 'form-1',
      answers: [{ questionId: 'q1', value: 'hola' }],
      score: 55,
      leadId: 'lead-1',
    })

    expect(from).toHaveBeenCalledWith('form_submissions')
    expect(insert).toHaveBeenCalledWith({
      id: 'submission-1',
      organization_id: 'org-1',
      form_id: 'form-1',
      answers: [{ questionId: 'q1', value: 'hola' }],
      score: 55,
      lead_id: 'lead-1',
    })
  })
})
