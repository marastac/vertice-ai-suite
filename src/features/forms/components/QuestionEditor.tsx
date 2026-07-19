import { useWatch } from 'react-hook-form'
import type { Control, FieldErrors, UseFormRegister, UseFormSetValue } from 'react-hook-form'
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from 'lucide-react'
import { Input } from '@/shared/ui/Input'
import { Button } from '@/shared/ui/Button'
import { CHOICE_QUESTION_TYPES } from '@/entities/form'
import type { FormBuilderInput, QuestionType } from '@/entities/form'
import { QuestionTypeSelector } from './QuestionTypeSelector'
import { OptionEditor } from './OptionEditor'

export interface QuestionEditorProps {
  index: number
  control: Control<FormBuilderInput>
  register: UseFormRegister<FormBuilderInput>
  setValue: UseFormSetValue<FormBuilderInput>
  errors?: FieldErrors<FormBuilderInput>
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  canMoveUp: boolean
  canMoveDown: boolean
}

export function QuestionEditor({
  index,
  control,
  register,
  setValue,
  errors,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: QuestionEditorProps) {
  const type = useWatch({ control, name: `questions.${index}.type` as never }) as unknown as QuestionType
  const isChoice = CHOICE_QUESTION_TYPES.includes(type)
  const isYesNo = type === 'yes_no'
  const questionErrors = errors?.questions?.[index]

  function handleTypeChange(newType: QuestionType) {
    setValue(`questions.${index}.type` as never, newType as never)
    if (newType === 'yes_no') {
      setValue(`questions.${index}.options` as never, [
        { id: crypto.randomUUID(), label: 'Sí', points: 0 },
        { id: crypto.randomUUID(), label: 'No', points: 0 },
      ] as never)
    } else if (CHOICE_QUESTION_TYPES.includes(newType)) {
      setValue(`questions.${index}.options` as never, [
        { id: crypto.randomUUID(), label: '', points: 0 },
        { id: crypto.randomUUID(), label: '', points: 0 },
      ] as never)
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-300">
          <GripVertical className="size-4 text-slate-600" />
          Pregunta {index + 1}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Subir pregunta"
            onClick={onMoveUp}
            disabled={!canMoveUp}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Bajar pregunta"
            onClick={onMoveDown}
            disabled={!canMoveDown}
          >
            <ArrowDown className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="sm" aria-label="Eliminar pregunta" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <Input
        label="Pregunta"
        placeholder="¿Cuál es tu presupuesto mensual?"
        error={questionErrors?.label?.message}
        {...register(`questions.${index}.label` as never)}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <QuestionTypeSelector value={type} onChange={handleTypeChange} />
        <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-slate-300">
          <input
            type="checkbox"
            className="size-4 rounded border-slate-700 bg-slate-900"
            {...register(`questions.${index}.required` as never)}
          />
          Pregunta obligatoria
        </label>
      </div>

      {isChoice ? (
        <OptionEditor questionIndex={index} control={control} register={register} errors={errors} locked={isYesNo} />
      ) : (
        <Input
          label="Puntos si se responde"
          type="number"
          min={0}
          max={100}
          error={questionErrors?.points?.message}
          {...register(`questions.${index}.points` as never)}
        />
      )}
    </div>
  )
}
