import type { z } from 'zod'
import type { chatQualificationStatusSchema } from '../schemas/chat.js'

type ChatQualificationStatus = z.infer<typeof chatQualificationStatusSchema>

const DISQUALIFIED_CEILING = 40

export function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** Default thresholds are 0-39 / 40-69 / 70-100 unless the saved config sets a custom minimum for "qualified". */
export function statusForScore(score: number, minQualifiedScore: number): ChatQualificationStatus {
  if (score < DISQUALIFIED_CEILING) return 'disqualified'
  if (score < minQualifiedScore) return 'qualifying'
  return 'qualified'
}
