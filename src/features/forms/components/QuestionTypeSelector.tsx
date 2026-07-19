import { Select } from '@/shared/ui/Select'
import { QUESTION_TYPES, questionTypeLabel } from '@/entities/form'
import type { QuestionType } from '@/entities/form'

export interface QuestionTypeSelectorProps {
  value: QuestionType
  onChange: (type: QuestionType) => void
  disabled?: boolean
}

export function QuestionTypeSelector({ value, onChange, disabled }: QuestionTypeSelectorProps) {
  return (
    <Select
      label="Tipo de pregunta"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as QuestionType)}
    >
      {QUESTION_TYPES.map((type) => (
        <option key={type} value={type}>
          {questionTypeLabel[type]}
        </option>
      ))}
    </Select>
  )
}
