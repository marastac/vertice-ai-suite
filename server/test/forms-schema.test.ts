import { describe, expect, it } from 'vitest'
import { submitPublicFormBodySchema } from '../src/schemas/forms.js'

// submitPublicFormBodySchema is the FIRST line of defense in the Fase C
// hardening: `.strict()` means a request carrying any field beyond
// `answers`/`website` is rejected OUTRIGHT (400), not silently stripped —
// see the schema's own doc comment for why this matters (organizationId,
// score, status, source, leadId, submissionId, chat_session_id are all
// authority fields a client must never be able to smuggle in).

const VALID_BODY = {
  answers: [{ questionId: 'q1', value: 'hola' }],
}

describe('submitPublicFormBodySchema', () => {
  it('accepts a normal, valid submission', () => {
    const result = submitPublicFormBodySchema.safeParse(VALID_BODY)
    expect(result.success).toBe(true)
  })

  it('accepts an explicit empty honeypot ("website") — the normal case for a real browser', () => {
    const result = submitPublicFormBodySchema.safeParse({ ...VALID_BODY, website: '' })
    expect(result.success).toBe(true)
  })

  it('accepts multiple-choice answers (array of option ids)', () => {
    const result = submitPublicFormBodySchema.safeParse({ answers: [{ questionId: 'q1', value: ['opt-a', 'opt-b'] }] })
    expect(result.success).toBe(true)
  })

  it.each(['organizationId', 'organization_id', 'score', 'status', 'source', 'leadId', 'submissionId', 'chat_session_id'])(
    'REJECTS a request that includes the authority field "%s" at the top level — .strict() means no unknown key survives',
    (field) => {
      const result = submitPublicFormBodySchema.safeParse({ ...VALID_BODY, [field]: 'attacker-controlled-value' })
      expect(result.success).toBe(false)
    },
  )

  it.each(['organizationId', 'score', 'status', 'leadId'])(
    'REJECTS an individual answer entry that includes the authority field "%s"',
    (field) => {
      const result = submitPublicFormBodySchema.safeParse({
        answers: [{ questionId: 'q1', value: 'hola', [field]: 'attacker-controlled-value' }],
      })
      expect(result.success).toBe(false)
    },
  )

  it('rejects an answer value longer than 2000 characters', () => {
    const result = submitPublicFormBodySchema.safeParse({ answers: [{ questionId: 'q1', value: 'a'.repeat(2001) }] })
    expect(result.success).toBe(false)
  })

  it('accepts an answer value at exactly the 2000-character limit', () => {
    const result = submitPublicFormBodySchema.safeParse({ answers: [{ questionId: 'q1', value: 'a'.repeat(2000) }] })
    expect(result.success).toBe(true)
  })

  it('rejects more than 100 answers in a single submission', () => {
    const answers = Array.from({ length: 101 }, (_, i) => ({ questionId: `q${i}`, value: 'x' }))
    const result = submitPublicFormBodySchema.safeParse({ answers })
    expect(result.success).toBe(false)
  })

  it('rejects more than 50 selected options in a multiple-choice answer', () => {
    const value = Array.from({ length: 51 }, (_, i) => `opt-${i}`)
    const result = submitPublicFormBodySchema.safeParse({ answers: [{ questionId: 'q1', value }] })
    expect(result.success).toBe(false)
  })

  it('rejects a missing questionId', () => {
    const result = submitPublicFormBodySchema.safeParse({ answers: [{ value: 'hola' }] })
    expect(result.success).toBe(false)
  })

  it('rejects a completely malformed body (answers missing)', () => {
    const result = submitPublicFormBodySchema.safeParse({})
    expect(result.success).toBe(false)
  })
})
