import type { FormQuestion } from './types'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isEmptyAnswer(value: string | string[] | undefined): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  return value.trim() === ''
}

export function validateFormAnswers(
  questions: FormQuestion[],
  answers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const errors: Record<string, string> = {}

  for (const question of questions) {
    const value = answers[question.id]
    const empty = isEmptyAnswer(value)

    if (question.required && empty) {
      errors[question.id] =
        question.type === 'single_choice' || question.type === 'multiple_choice' || question.type === 'yes_no'
          ? 'Selecciona una opción.'
          : 'Este campo es obligatorio.'
      continue
    }

    if (empty || typeof value !== 'string') continue

    if (question.type === 'email' && !EMAIL_PATTERN.test(value.trim())) {
      errors[question.id] = 'Introduce un correo electrónico válido.'
    }

    if (question.type === 'phone' && value.trim().length < 6) {
      errors[question.id] = 'Introduce un teléfono válido.'
    }

    if (question.type === 'number' && Number.isNaN(Number(value))) {
      errors[question.id] = 'Introduce un número válido.'
    }
  }

  return errors
}
