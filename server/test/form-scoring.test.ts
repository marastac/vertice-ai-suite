import { describe, expect, it } from 'vitest'
import { computeMaxScore, computeSubmissionScore, scoreToLeadStatus } from '../src/services/form-scoring.js'
import type { FormQuestion } from '../src/schemas/forms.js'

// Exact backend port of src/entities/form/scoring.ts's pure logic — this is
// the ONLY place a public form submission's score/status is computed (see
// form-submission-service.ts), always server-side, never trusting a
// client-supplied value.

const QUESTIONS: FormQuestion[] = [
  { id: 'q-email', type: 'email', label: 'Correo', required: true },
  {
    id: 'q-budget',
    type: 'single_choice',
    label: 'Presupuesto',
    required: true,
    options: [
      { id: 'low', label: 'Bajo', points: 10 },
      { id: 'high', label: 'Alto', points: 50 },
    ],
  },
  { id: 'q-notes', type: 'short_text', label: 'Notas', required: false, points: 20 },
]

describe('computeMaxScore', () => {
  it('sums the max points across all questions (best single_choice option + fixed points)', () => {
    // q-email has no points -> 0; q-budget max option is 50; q-notes is 20.
    expect(computeMaxScore(QUESTIONS)).toBe(70)
  })
})

describe('computeSubmissionScore', () => {
  it('computes 100 when every question earns its maximum', () => {
    const score = computeSubmissionScore(QUESTIONS, [
      { questionId: 'q-email', value: 'a@b.com' },
      { questionId: 'q-budget', value: 'high' },
      { questionId: 'q-notes', value: 'algo' },
    ])
    expect(score).toBe(100)
  })

  it('computes a partial score when only some questions earn points', () => {
    // Only q-budget answered, "low" = 10 points out of a 70 max -> round(10/70*100) = 14
    const score = computeSubmissionScore(QUESTIONS, [{ questionId: 'q-budget', value: 'low' }])
    expect(score).toBe(14)
  })

  it('returns 0 when no answers match any question', () => {
    expect(computeSubmissionScore(QUESTIONS, [])).toBe(0)
  })

  it('gives 0 points for a manipulated/nonexistent option id — never a crash, never a fabricated score', () => {
    const score = computeSubmissionScore(QUESTIONS, [{ questionId: 'q-budget', value: 'nonexistent-option' }])
    expect(score).toBe(0)
  })

  it('returns 0 when the form has no scoreable questions at all (max score 0)', () => {
    expect(computeSubmissionScore([{ id: 'q1', type: 'short_text', label: 'x', required: false }], [])).toBe(0)
  })
})

describe('scoreToLeadStatus', () => {
  it('returns "qualified" for a score of 70 or above', () => {
    expect(scoreToLeadStatus(70)).toBe('qualified')
    expect(scoreToLeadStatus(100)).toBe('qualified')
  })

  it('returns "qualifying" for a score between 40 and 69', () => {
    expect(scoreToLeadStatus(40)).toBe('qualifying')
    expect(scoreToLeadStatus(69)).toBe('qualifying')
  })

  it('returns "disqualified" for a score below 40', () => {
    expect(scoreToLeadStatus(39)).toBe('disqualified')
    expect(scoreToLeadStatus(0)).toBe('disqualified')
  })
})
