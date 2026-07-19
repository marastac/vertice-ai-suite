import { useFieldArray, useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Plus } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { Select } from '@/shared/ui/Select'
import { Textarea } from '@/shared/ui/Textarea'
import { FORM_STATUSES, formBuilderSchema, formStatusLabel } from '@/entities/form'
import type { FormBuilderInput, FormBuilderValues, FormQuestion } from '@/entities/form'
import { QuestionEditor } from './QuestionEditor'
import { FormPreview } from './FormPreview'

export interface FormBuilderProps {
  defaultValues?: Partial<FormBuilderValues>
  onSubmit: (values: FormBuilderValues) => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  submitError?: string | null
  submitLabel: string
}

function blankQuestion(): FormQuestion {
  return {
    id: crypto.randomUUID(),
    type: 'short_text',
    label: '',
    required: true,
    points: 10,
  }
}

export function FormBuilder({
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting,
  submitError,
  submitLabel,
}: FormBuilderProps) {
  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormBuilderInput, unknown, FormBuilderValues>({
    resolver: zodResolver(formBuilderSchema),
    defaultValues: {
      name: '',
      description: '',
      status: 'draft',
      questions: [],
      ...defaultValues,
    },
  })

  const { fields, append, remove, move } = useFieldArray({ control, name: 'questions' })
  const watchedName = useWatch({ control, name: 'name' })
  const watchedDescription = useWatch({ control, name: 'description' })
  const watchedQuestions = useWatch({ control, name: 'questions' })

  const questionsRootError = (errors.questions as { message?: string } | undefined)?.message

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6 lg:col-span-3">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Nombre del formulario *"
            placeholder="Formulario de descubrimiento"
            error={errors.name?.message}
            className="sm:col-span-2"
            {...register('name')}
          />
          <Textarea
            label="Descripción"
            placeholder="¿Para qué sirve este formulario?"
            error={errors.description?.message}
            className="sm:col-span-2"
            {...register('description')}
          />
          <Select label="Estado" error={errors.status?.message} {...register('status')}>
            {FORM_STATUSES.map((status) => (
              <option key={status} value={status}>
                {formStatusLabel[status]}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">Preguntas</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<Plus className="size-4" />}
              onClick={() => append(blankQuestion())}
            >
              Añadir pregunta
            </Button>
          </div>

          {questionsRootError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="size-4 shrink-0" />
              {questionsRootError}
            </div>
          )}

          {fields.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">
              Todavía no has añadido preguntas.
            </p>
          )}

          <div className="flex flex-col gap-4">
            {fields.map((field, index) => (
              <QuestionEditor
                key={field.id}
                index={index}
                control={control}
                register={register}
                setValue={setValue}
                errors={errors}
                onRemove={() => remove(index)}
                onMoveUp={() => move(index, index - 1)}
                onMoveDown={() => move(index, index + 1)}
                canMoveUp={index > 0}
                canMoveDown={index < fields.length - 1}
              />
            ))}
          </div>
        </div>

        {submitError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            {submitError}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            Cancelar
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            {submitLabel}
          </Button>
        </div>
      </form>

      <div className="lg:col-span-2">
        <FormPreview
          name={(watchedName as string | undefined) ?? ''}
          description={watchedDescription as string | undefined}
          questions={(watchedQuestions ?? []) as FormQuestion[]}
        />
      </div>
    </div>
  )
}
