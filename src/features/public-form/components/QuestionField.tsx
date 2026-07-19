import { Input } from '@/shared/ui/Input'
import { Textarea } from '@/shared/ui/Textarea'
import type { FormQuestion } from '@/entities/form'

export interface QuestionFieldProps {
  question: FormQuestion
  value: string | string[] | undefined
  onChange: (value: string | string[]) => void
  error?: string
}

export function QuestionField({ question, value, onChange, error }: QuestionFieldProps) {
  const textValue = typeof value === 'string' ? value : ''

  switch (question.type) {
    case 'short_text':
      return <Input value={textValue} onChange={(event) => onChange(event.target.value)} error={error} />
    case 'long_text':
      return <Textarea value={textValue} onChange={(event) => onChange(event.target.value)} error={error} />
    case 'email':
      return <Input type="email" value={textValue} onChange={(event) => onChange(event.target.value)} error={error} />
    case 'phone':
      return <Input type="tel" value={textValue} onChange={(event) => onChange(event.target.value)} error={error} />
    case 'number':
      return <Input type="number" value={textValue} onChange={(event) => onChange(event.target.value)} error={error} />
    case 'single_choice':
    case 'yes_no':
      return (
        <div className="flex flex-col gap-2">
          {(question.options ?? []).map((option) => (
            <label
              key={option.id}
              className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-200 hover:border-slate-600"
            >
              <input
                type="radio"
                name={question.id}
                value={option.id}
                checked={value === option.id}
                onChange={() => onChange(option.id)}
                className="size-4 border-slate-700 bg-slate-900"
              />
              {option.label}
            </label>
          ))}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )
    case 'multiple_choice': {
      const selected = Array.isArray(value) ? value : []
      return (
        <div className="flex flex-col gap-2">
          {(question.options ?? []).map((option) => (
            <label
              key={option.id}
              className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-200 hover:border-slate-600"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={(event) => {
                  if (event.target.checked) onChange([...selected, option.id])
                  else onChange(selected.filter((id) => id !== option.id))
                }}
                className="size-4 rounded border-slate-700 bg-slate-900"
              />
              {option.label}
            </label>
          ))}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )
    }
    default:
      return null
  }
}
