import { useFieldArray } from 'react-hook-form'
import type { Control, FieldErrors, UseFormRegister } from 'react-hook-form'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import type { ChatSettingsInput } from '@/entities/chat'

export interface CriteriaEditorProps {
  control: Control<ChatSettingsInput>
  register: UseFormRegister<ChatSettingsInput>
  errors?: FieldErrors<ChatSettingsInput>
}

export function CriteriaEditor({ control, register, errors }: CriteriaEditorProps) {
  const { fields, append, remove, move } = useFieldArray({ control, name: 'criteria' })
  const criteriaErrors = errors?.criteria

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-200">Criterios de calificación</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<Plus className="size-4" />}
          onClick={() => append({ id: crypto.randomUUID(), label: '', points: 10 })}
        >
          Añadir criterio
        </Button>
      </div>

      {fields.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">
          Todavía no has añadido criterios de calificación.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {fields.map((field, index) => (
          <div key={field.id} className="flex items-start gap-2">
            <Input
              placeholder={`Criterio ${index + 1}`}
              className="flex-1"
              error={criteriaErrors?.[index]?.label?.message}
              {...register(`criteria.${index}.label`)}
            />
            <Input
              type="number"
              min={0}
              max={100}
              placeholder="Puntos"
              className="w-24"
              error={criteriaErrors?.[index]?.points?.message}
              {...register(`criteria.${index}.points`)}
            />
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Subir criterio"
                onClick={() => move(index, index - 1)}
                disabled={index === 0}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Bajar criterio"
                onClick={() => move(index, index + 1)}
                disabled={index === fields.length - 1}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" aria-label="Eliminar criterio" onClick={() => remove(index)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
