import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Copy, FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Button } from '@/shared/ui/Button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/Card'
import { EmptyState } from '@/shared/ui/EmptyState'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import {
  formatFormDate,
  useDeleteFormMutation,
  useDuplicateFormMutation,
  useFormsQuery,
  useSetFormStatusMutation,
} from '@/entities/form'
import type { QualificationFormWithStats } from '@/entities/form'
import { FormStatusBadge } from './components/FormStatusBadge'

export function FormsPage() {
  const navigate = useNavigate()
  const { data: forms, isLoading, isError, refetch } = useFormsQuery()
  const duplicateMutation = useDuplicateFormMutation()
  const setStatusMutation = useSetFormStatusMutation()
  const deleteMutation = useDeleteFormMutation()
  const [formToDelete, setFormToDelete] = useState<QualificationFormWithStats | null>(null)

  async function handleDuplicate(id: string) {
    await duplicateMutation.mutateAsync(id)
  }

  async function handleToggleStatus(form: QualificationFormWithStats) {
    await setStatusMutation.mutateAsync({ id: form.id, status: form.status === 'active' ? 'draft' : 'active' })
  }

  async function handleDelete() {
    if (!formToDelete) return
    await deleteMutation.mutateAsync(formToDelete.id)
    setFormToDelete(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Formularios de calificación"
        description="Diseña las preguntas que Lead AI usa para puntuar y calificar nuevos leads."
        actions={
          <Button leftIcon={<Plus className="size-4" />} onClick={() => navigate('/forms/new')}>
            Nuevo formulario
          </Button>
        }
      />

      {isLoading && (
        <Card className="flex flex-col gap-3 p-5">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
          ))}
        </Card>
      )}

      {isError && !isLoading && (
        <EmptyState
          title="No se pudieron cargar los formularios"
          description="Ha ocurrido un problema al leer los datos guardados en este navegador."
          action={
            <Button variant="secondary" leftIcon={<RefreshCw className="size-4" />} onClick={() => refetch()}>
              Reintentar
            </Button>
          }
        />
      )}

      {!isLoading && !isError && forms && forms.length === 0 && (
        <EmptyState
          icon={<FileText className="size-5" />}
          title="Aún no tienes formularios"
          description="Crea tu primer formulario de calificación para empezar a captar leads."
          action={
            <Button leftIcon={<Plus className="size-4" />} onClick={() => navigate('/forms/new')}>
              Nuevo formulario
            </Button>
          }
        />
      )}

      {!isLoading && !isError && forms && forms.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {forms.map((form) => (
            <Card key={form.id} className="flex flex-col">
              <CardHeader className="flex-row items-start justify-between">
                <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
                  <FileText className="size-4" />
                </span>
                <FormStatusBadge status={form.status} />
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                <div>
                  <CardTitle>{form.name}</CardTitle>
                  {form.description && <CardDescription className="mt-1">{form.description}</CardDescription>}
                </div>
                <p className="text-xs text-slate-500">
                  {form.questions.length} preguntas · {form.submissionCount} envíos · Actualizado el{' '}
                  {formatFormDate(form.updatedAt)}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Pencil className="size-4" />}
                    onClick={() => navigate(`/forms/${form.id}/edit`)}
                  >
                    Editar
                  </Button>
                  <Link
                    to={`/forms/${form.id}/submissions`}
                    className="text-sm font-medium text-blue-400 hover:text-blue-300"
                  >
                    Envíos
                  </Link>
                  <Button variant="ghost" size="sm" aria-label="Duplicar formulario" onClick={() => handleDuplicate(form.id)}>
                    <Copy className="size-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleToggleStatus(form)}>
                    {form.status === 'active' ? 'Desactivar' : 'Activar'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Eliminar formulario"
                    onClick={() => setFormToDelete(form)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={Boolean(formToDelete)}
        title="Eliminar formulario"
        description={
          formToDelete ? `¿Seguro que quieres eliminar "${formToDelete.name}"? Esta acción no se puede deshacer.` : undefined
        }
        confirmLabel="Eliminar"
        cancelLabel="Cancelar"
        isConfirming={deleteMutation.isPending}
        onConfirm={handleDelete}
        onCancel={() => setFormToDelete(null)}
      />
    </div>
  )
}
