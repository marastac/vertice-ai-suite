import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle2, Sparkles } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Card, CardContent } from '@/shared/ui/Card'
import { usePublicFormQuery, useSubmitFormMutation, validateFormAnswers } from '@/entities/form'
import type { FormSubmissionAnswer } from '@/entities/form'
import { QuestionField } from './components/QuestionField'

export function PublicFormPage() {
  const { formId } = useParams<{ formId: string }>()
  const { data: form, isLoading } = usePublicFormQuery(formId)
  const submitMutation = useSubmitFormMutation()
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const answeredCount = useMemo(() => {
    if (!form) return 0
    return form.questions.filter((question) => {
      const value = answers[question.id]
      return typeof value === 'string' ? value.trim() !== '' : Array.isArray(value) && value.length > 0
    }).length
  }, [form, answers])

  function handleAnswerChange(questionId: string, value: string | string[]) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }))
    setErrors((prev) => {
      if (!prev[questionId]) return prev
      const next = { ...prev }
      delete next[questionId]
      return next
    })
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!form) return

    const validation = validateFormAnswers(form.questions, answers)
    if (Object.keys(validation).length > 0) {
      setErrors(validation)
      return
    }

    const payload: FormSubmissionAnswer[] = form.questions
      .filter((question) => answers[question.id] !== undefined)
      .map((question) => ({ questionId: question.id, value: answers[question.id] as string | string[] }))

    setSubmitError(null)
    try {
      await submitMutation.mutateAsync({ formId: form.id, answers: payload })
      setIsSubmitted(true)
    } catch {
      setSubmitError('No se pudo enviar el formulario. Inténtalo de nuevo.')
    }
  }

  return (
    <div className="min-h-screen bg-vertice-bg px-4 py-10 text-slate-100 sm:px-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
            <Sparkles className="size-4 text-white" />
          </span>
          <span className="text-sm font-semibold text-white">Lead AI</span>
        </div>

        {isLoading && (
          <Card className="p-8">
            <div className="h-6 w-2/3 animate-pulse rounded bg-slate-800/60" />
            <div className="mt-4 h-32 animate-pulse rounded bg-slate-800/60" />
          </Card>
        )}

        {!isLoading && (!form || form.status !== 'active') && (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <h1 className="text-lg font-semibold text-white">Este formulario no está disponible</h1>
              <p className="max-w-sm text-sm text-slate-400">
                El formulario que buscas no existe o ya no está activo. Ponte en contacto con quien te compartió este enlace.
              </p>
            </CardContent>
          </Card>
        )}

        {!isLoading && form && form.status === 'active' && isSubmitted && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300">
                <CheckCircle2 className="size-6" />
              </span>
              <h1 className="text-lg font-semibold text-white">¡Gracias por completar el formulario!</h1>
              <p className="max-w-sm text-sm text-slate-400">
                Hemos recibido tu información. Nos pondremos en contacto contigo muy pronto.
              </p>
            </CardContent>
          </Card>
        )}

        {!isLoading && form && form.status === 'active' && !isSubmitted && (
          <Card>
            <CardContent className="flex flex-col gap-6 pt-6">
              <div>
                <h1 className="text-xl font-semibold text-white">{form.name}</h1>
                {form.description && <p className="mt-1 text-sm text-slate-400">{form.description}</p>}
              </div>

              <div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-600 transition-all"
                    style={{
                      width: `${form.questions.length === 0 ? 0 : (answeredCount / form.questions.length) * 100}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  {answeredCount} de {form.questions.length} preguntas respondidas
                </p>
              </div>

              <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
                {form.questions.map((question, index) => (
                  <div key={question.id} className="flex flex-col gap-2">
                    <label className="text-sm font-medium text-slate-200">
                      {index + 1}. {question.label}
                      {question.required && <span className="ml-1 text-red-400">*</span>}
                    </label>
                    <QuestionField
                      question={question}
                      value={answers[question.id]}
                      onChange={(value) => handleAnswerChange(question.id, value)}
                      error={errors[question.id]}
                    />
                  </div>
                ))}

                {submitError && <p className="text-sm text-red-400">{submitError}</p>}

                <Button type="submit" isLoading={submitMutation.isPending} className="w-full">
                  Enviar
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
