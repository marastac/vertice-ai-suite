import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { questionTypeLabel } from '@/entities/form'
import type { FormQuestion } from '@/entities/form'

export interface FormPreviewProps {
  name: string
  description?: string
  questions: FormQuestion[]
}

export function FormPreview({ name, description, questions }: FormPreviewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vista previa</CardTitle>
        <CardDescription>Así verán tus leads este formulario.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div>
          <h3 className="text-lg font-semibold text-white">{name || 'Formulario sin título'}</h3>
          {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
        </div>

        {questions.length === 0 ? (
          <p className="text-sm text-slate-500">Añade preguntas para verlas aquí.</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {questions.map((question, index) => (
              <li key={question.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-100">
                    {index + 1}. {question.label || 'Pregunta sin título'}
                    {question.required && <span className="ml-1 text-red-400">*</span>}
                  </p>
                  <Badge variant="neutral">{questionTypeLabel[question.type]}</Badge>
                </div>
                {question.options && question.options.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {question.options.map((option) => (
                      <li key={option.id} className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">
                        {option.label || 'Opción'} · {option.points} pts
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
