import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Button } from '@/shared/ui/Button'
import { useCreateFormMutation, useFormQuery, useUpdateFormMutation } from '@/entities/form'
import type { FormBuilderValues } from '@/entities/form'
import { FormBuilder } from './components/FormBuilder'

export function FormBuilderPage() {
  const { formId } = useParams<{ formId: string }>()
  const navigate = useNavigate()
  const isEditMode = Boolean(formId)
  const { data: form, isLoading, isError, refetch } = useFormQuery(formId)
  const createMutation = useCreateFormMutation()
  const updateMutation = useUpdateFormMutation()

  if (isEditMode && isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-slate-800/60" />
        <div className="h-96 animate-pulse rounded-xl bg-slate-800/60" />
      </div>
    )
  }

  if (isEditMode && isError) {
    return (
      <EmptyState
        title="No se pudo cargar el formulario"
        description="Ha ocurrido un problema al leer los datos guardados en este navegador."
        action={
          <Button variant="secondary" onClick={() => refetch()}>
            Reintentar
          </Button>
        }
      />
    )
  }

  if (isEditMode && !form) {
    return (
      <EmptyState
        title="Formulario no encontrado"
        description="Este formulario no existe o puede haber sido eliminado."
        action={
          <Button variant="secondary" onClick={() => navigate('/forms')}>
            Volver a formularios
          </Button>
        }
      />
    )
  }

  async function handleSubmit(values: FormBuilderValues) {
    if (isEditMode && formId) {
      await updateMutation.mutateAsync({ id: formId, input: values })
    } else {
      await createMutation.mutateAsync(values)
    }
    navigate('/forms')
  }

  const mutation = isEditMode ? updateMutation : createMutation

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={isEditMode ? 'Editar formulario' : 'Nuevo formulario'}
        description="Configura las preguntas y la puntuación que Lead AI usará para calificar leads."
      />
      <FormBuilder
        defaultValues={
          form
            ? { name: form.name, description: form.description, status: form.status, questions: form.questions }
            : undefined
        }
        onSubmit={handleSubmit}
        onCancel={() => navigate('/forms')}
        isSubmitting={mutation.isPending}
        submitError={mutation.isError ? 'No se pudo guardar el formulario. Inténtalo de nuevo.' : null}
        submitLabel={isEditMode ? 'Guardar cambios' : 'Crear formulario'}
      />
    </div>
  )
}
