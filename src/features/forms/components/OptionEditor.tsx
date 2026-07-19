import { useFieldArray } from 'react-hook-form'
import type { Control, FieldErrors, UseFormRegister } from 'react-hook-form'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import type { FormBuilderInput } from '@/entities/form'

export interface OptionEditorProps {
  questionIndex: number
  control: Control<FormBuilderInput>
  register: UseFormRegister<FormBuilderInput>
  errors?: FieldErrors<FormBuilderInput>
  locked?: boolean
}

export function OptionEditor({ questionIndex, control, register, errors, locked }: OptionEditorProps) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: `questions.${questionIndex}.options` as never,
  })

  const optionErrors = errors?.questions?.[questionIndex]?.options as
    | { message?: string }
    | Array<{ label?: { message?: string }; points?: { message?: string } }>
    | undefined
  const optionErrorMessage = optionErrors && !Array.isArray(optionErrors) ? optionErrors.message : undefined
  const optionFieldErrors = Array.isArray(optionErrors) ? optionErrors : undefined

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-slate-200">Opciones</p>
      {fields.map((field, optionIndex) => (
        <div key={field.id} className="flex items-start gap-2">
          <Input
            placeholder={`Opción ${optionIndex + 1}`}
            disabled={locked}
            error={optionFieldErrors?.[optionIndex]?.label?.message}
            className="flex-1"
            {...register(`questions.${questionIndex}.options.${optionIndex}.label` as never)}
          />
          <Input
            type="number"
            min={0}
            max={100}
            placeholder="Puntos"
            className="w-28"
            error={optionFieldErrors?.[optionIndex]?.points?.message}
            {...register(`questions.${questionIndex}.options.${optionIndex}.points` as never)}
          />
          {!locked && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Eliminar opción"
              onClick={() => remove(optionIndex)}
              disabled={fields.length <= 2}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      ))}
      {optionErrorMessage && <p className="text-xs text-red-400">{optionErrorMessage}</p>}
      {!locked && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<Plus className="size-4" />}
          onClick={() => append({ id: crypto.randomUUID(), label: '', points: 0 } as never)}
        >
          Añadir opción
        </Button>
      )}
    </div>
  )
}
