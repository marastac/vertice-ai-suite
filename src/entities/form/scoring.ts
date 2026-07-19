import type { LeadStatus } from '@/entities/lead'
import { CHOICE_QUESTION_TYPES } from './schema'
import type { FormQuestion, FormSubmissionAnswer } from './types'

function maxPointsForQuestion(question: FormQuestion): number {
  if (CHOICE_QUESTION_TYPES.includes(question.type)) {
    const options = question.options ?? []
    if (question.type === 'multiple_choice') {
      return options.filter((option) => option.points > 0).reduce((sum, option) => sum + option.points, 0)
    }
    return options.reduce((max, option) => Math.max(max, option.points), 0)
  }
  return question.points ?? 0
}

function earnedPointsForQuestion(question: FormQuestion, answer: FormSubmissionAnswer | undefined): number {
  if (!answer) return 0

  if (question.type === 'single_choice' || question.type === 'yes_no') {
    const optionId = typeof answer.value === 'string' ? answer.value : undefined
    const option = question.options?.find((item) => item.id === optionId)
    return option?.points ?? 0
  }

  if (question.type === 'multiple_choice') {
    const optionIds = Array.isArray(answer.value) ? answer.value : []
    const options = question.options ?? []
    return optionIds.reduce((sum, id) => {
      const option = options.find((item) => item.id === id)
      return sum + (option?.points ?? 0)
    }, 0)
  }

  const hasValue = typeof answer.value === 'string' && answer.value.trim() !== ''
  return hasValue ? (question.points ?? 0) : 0
}

export function computeMaxScore(questions: FormQuestion[]): number {
  return questions.reduce((sum, question) => sum + maxPointsForQuestion(question), 0)
}

export function computeSubmissionScore(questions: FormQuestion[], answers: FormSubmissionAnswer[]): number {
  const maxScore = computeMaxScore(questions)
  if (maxScore <= 0) return 0

  const earned = questions.reduce((sum, question) => {
    const answer = answers.find((item) => item.questionId === question.id)
    return sum + earnedPointsForQuestion(question, answer)
  }, 0)

  const percentage = Math.round((earned / maxScore) * 100)
  return Math.min(100, Math.max(0, percentage))
}

export function scoreToLeadStatus(score: number): LeadStatus {
  if (score >= 70) return 'qualified'
  if (score >= 40) return 'qualifying'
  return 'disqualified'
}
