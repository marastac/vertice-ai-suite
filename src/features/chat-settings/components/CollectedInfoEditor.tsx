import { useFieldArray } from 'react-hook-form'
import type { Control, FieldErrors, UseFormRegister } from 'react-hook-form'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import type { ChatSettingsInput } from '@/entities/chat'

export interface CollectedInfoEditorProps {
  control: Control<ChatSettingsInput>
  register: UseFormRegister<ChatSettingsInput>
  errors?: FieldErrors<ChatSettingsInput>
}

export function CollectedInfoEditor({ control, register, errors }: CollectedInfoEditorProps) {
  const { fields, append, remove, move } = useFieldArray({ control, name: 'questionsToCollect' })
  const questionErrors = errors?.questionsToCollect

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-200">Información que el asistente debe recopilar</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          leftIcon={<Plus className="size-4" />}
          onClick={() => append({ id: crypto.randomUUID(), value: '' })}
        >
          Añadir
        </Button>
      </div>

      {fields.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">
          Todavía no has añadido elementos a recopilar.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {fields.map((field, index) => (
          <div key={field.id} className="flex items-start gap-2">
            <Input
              placeholder="Ej. Presupuesto aproximado"
              className="flex-1"
              error={questionErrors?.[index]?.value?.message}
              {...register(`questionsToCollect.${index}.value`)}
            />
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Subir elemento"
                onClick={() => move(index, index - 1)}
                disabled={index === 0}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Bajar elemento"
                onClick={() => move(index, index + 1)}
                disabled={index === fields.length - 1}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" aria-label="Eliminar elemento" onClick={() => remove(index)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
