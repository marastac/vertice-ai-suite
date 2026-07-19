import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Briefcase, Building2, Calendar, Mail, MessagesSquare, Pencil, Phone, Trash2, Wallet } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Select } from '@/shared/ui/Select'
import { Button } from '@/shared/ui/Button'
import { Modal } from '@/shared/ui/Modal'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { mockTeamMembers } from '@/entities/team-member'
import {
  LEAD_STATUSES,
  formatLeadBudget,
  formatLeadDate,
  formatLeadDateTime,
  leadSourceLabel,
  leadStatusLabel,
  useDeleteLeadMutation,
  useLeadQuery,
  useUpdateLeadMutation,
} from '@/entities/lead'
import type { LeadFormValues, LeadStatus } from '@/entities/lead'
import { LeadForm } from './components/LeadForm'

export function LeadDetailPage() {
  const { leadId } = useParams<{ leadId: string }>()
  const navigate = useNavigate()
  const { data: lead, isLoading, isError, refetch } = useLeadQuery(leadId)
  const updateMutation = useUpdateLeadMutation()
  const deleteMutation = useDeleteLeadMutation()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-6 w-32 animate-pulse rounded-lg bg-slate-800/60" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-800/60" />
        <div className="h-64 animate-pulse rounded-xl bg-slate-800/60" />
      </div>
    )
  }

  if (isError) {
    return (
      <EmptyState
        title="No se pudo cargar el lead"
        description="Ha ocurrido un problema al leer los datos guardados en este navegador."
        action={
          <Button variant="secondary" onClick={() => refetch()}>
            Reintentar
          </Button>
        }
      />
    )
  }

  if (!lead) {
    return (
      <EmptyState
        title="Lead no encontrado"
        description="Este lead no existe o puede haber sido eliminado."
        action={
          <Link to="/leads" className="text-sm font-medium text-blue-400 hover:text-blue-300">
            ← Volver a leads
          </Link>
        }
      />
    )
  }

  const assignedMember = mockTeamMembers.find((member) => member.id === lead.assignedTo)

  const editDefaultValues: Partial<LeadFormValues> = {
    name: lead.name,
    email: lead.email,
    phone: lead.phone ?? '',
    company: lead.company,
    position: lead.position ?? '',
    source: lead.source,
    status: lead.status,
    estimatedBudget: lead.estimatedBudget,
    assignedTo: lead.assignedTo ?? '',
    score: lead.score,
    notes: lead.notes ?? '',
  }

  async function handleStatusChange(event: ChangeEvent<HTMLSelectElement>) {
    if (!lead) return
    await updateMutation.mutateAsync({ id: lead.id, patch: { status: event.target.value as LeadStatus } })
  }

  async function handleEditSubmit(values: LeadFormValues) {
    if (!lead) return
    await updateMutation.mutateAsync({ id: lead.id, patch: values })
    setIsEditOpen(false)
  }

  async function handleDelete() {
    if (!lead) return
    await deleteMutation.mutateAsync(lead.id)
    navigate('/leads')
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/leads"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-400 hover:text-slate-200"
      >
        <ArrowLeft className="size-4" />
        Volver a leads
      </Link>

      <PageHeader
        title={lead.name}
        description={lead.company}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Cambiar estado del lead"
              value={lead.status}
              onChange={handleStatusChange}
              disabled={updateMutation.isPending}
              className="w-auto"
            >
              {LEAD_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {leadStatusLabel[status]}
                </option>
              ))}
            </Select>
            <Button variant="secondary" size="sm" leftIcon={<Pencil className="size-4" />} onClick={() => setIsEditOpen(true)}>
              Editar
            </Button>
            <Button variant="danger" size="sm" leftIcon={<Trash2 className="size-4" />} onClick={() => setIsDeleteOpen(true)}>
              Eliminar
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Conversación</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState
                icon={<MessagesSquare className="size-5" />}
                title="Sin conversación todavía"
                description="Cuando la calificación por chat con IA esté activa, aquí aparecerá la transcripción completa."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Actividad</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-4">
                {lead.activity.map((entry) => (
                  <li key={entry.id} className="flex gap-3">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-purple-600" />
                    <div>
                      <p className="text-sm text-slate-200">{entry.message}</p>
                      <p className="text-xs text-slate-500">{formatLeadDateTime(entry.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Detalles de contacto</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-2 text-slate-300">
                <Mail className="size-4 shrink-0 text-slate-500" />
                {lead.email}
              </div>
              {lead.phone && (
                <div className="flex items-center gap-2 text-slate-300">
                  <Phone className="size-4 shrink-0 text-slate-500" />
                  {lead.phone}
                </div>
              )}
              <div className="flex items-center gap-2 text-slate-300">
                <Building2 className="size-4 shrink-0 text-slate-500" />
                {lead.company}
              </div>
              {lead.position && (
                <div className="flex items-center gap-2 text-slate-300">
                  <Briefcase className="size-4 shrink-0 text-slate-500" />
                  {lead.position}
                </div>
              )}
              <div className="flex items-center gap-2 text-slate-300">
                <Calendar className="size-4 shrink-0 text-slate-500" />
                Capturado el {formatLeadDate(lead.createdAt)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Puntuación de calificación</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-white">
                {lead.score}
                <span className="text-base font-normal text-slate-500">/100</span>
              </p>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-600"
                  style={{ width: `${lead.score}%` }}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Origen y asignación</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm text-slate-300">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Fuente</span>
                <span>{leadSourceLabel[lead.source]}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Asignado a</span>
                <span>{assignedMember?.name ?? 'Sin asignar'}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-slate-500">
                  <Wallet className="size-4" />
                  Presupuesto
                </span>
                <span>{formatLeadBudget(lead.estimatedBudget)}</span>
              </div>
              {lead.formId && (
                <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-3">
                  <span className="text-slate-500">Formulario de origen</span>
                  <Link
                    to={`/forms/${lead.formId}/submissions`}
                    className="font-medium text-blue-400 hover:text-blue-300"
                  >
                    Ver envío
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Notas</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-300">{lead.notes || 'Sin notas todavía.'}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title="Editar lead"
        description="Actualiza la información de contacto, estado, puntuación y asignación."
      >
        <LeadForm
          mode="edit"
          defaultValues={editDefaultValues}
          teamMembers={mockTeamMembers}
          onSubmit={handleEditSubmit}
          onCancel={() => setIsEditOpen(false)}
          isSubmitting={updateMutation.isPending}
          submitError={updateMutation.isError ? 'No se pudieron guardar los cambios. Inténtalo de nuevo.' : null}
        />
      </Modal>

      <ConfirmDialog
        isOpen={isDeleteOpen}
        title="Eliminar lead"
        description={`¿Seguro que quieres eliminar a ${lead.name}? Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar"
        cancelLabel="Cancelar"
        isConfirming={deleteMutation.isPending}
        onConfirm={handleDelete}
        onCancel={() => setIsDeleteOpen(false)}
      />
    </div>
  )
}
