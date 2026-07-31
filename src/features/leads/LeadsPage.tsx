import { useMemo, useState } from 'react'
import { Plus, RefreshCw, Users } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card } from '@/shared/ui/Card'
import { Button } from '@/shared/ui/Button'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Modal } from '@/shared/ui/Modal'
import { useTeamMembersQuery } from '@/entities/team-member'
import { useCreateLeadMutation, useLeadsQuery } from '@/entities/lead'
import type { LeadFormValues } from '@/entities/lead'
import { LeadFiltersBar } from './components/LeadFiltersBar'
import { defaultLeadFilters } from './lead-filters'
import type { LeadFilters } from './lead-filters'
import { LeadsTable } from './components/LeadsTable'
import { LeadForm } from './components/LeadForm'

export function LeadsPage() {
  const { data: leads, isLoading, isError, refetch } = useLeadsQuery()
  const { data: teamMembers = [] } = useTeamMembersQuery()
  const createMutation = useCreateLeadMutation()
  const [filters, setFilters] = useState<LeadFilters>(defaultLeadFilters)
  const [isCreateOpen, setIsCreateOpen] = useState(false)

  const filteredLeads = useMemo(() => {
    if (!leads) return []
    const search = filters.search.trim().toLowerCase()
    const scoreMin = filters.scoreMin === '' ? 0 : Number(filters.scoreMin)
    const scoreMax = filters.scoreMax === '' ? 100 : Number(filters.scoreMax)

    const result = leads.filter((lead) => {
      const matchesSearch =
        search === '' ||
        lead.name.toLowerCase().includes(search) ||
        lead.company.toLowerCase().includes(search) ||
        lead.email.toLowerCase().includes(search)
      const matchesStatus = filters.status === 'all' || lead.status === filters.status
      const matchesSource = filters.source === 'all' || lead.source === filters.source
      const matchesAssigned =
        filters.assignedTo === 'all' ||
        (filters.assignedTo === 'unassigned' ? !lead.assignedTo : lead.assignedTo === filters.assignedTo)
      const matchesScore = lead.score >= scoreMin && lead.score <= scoreMax

      return matchesSearch && matchesStatus && matchesSource && matchesAssigned && matchesScore
    })

    return [...result].sort((a, b) => {
      switch (filters.sort) {
        case 'oldest':
          return a.createdAt.localeCompare(b.createdAt)
        case 'score-desc':
          return b.score - a.score
        case 'score-asc':
          return a.score - b.score
        case 'newest':
        default:
          return b.createdAt.localeCompare(a.createdAt)
      }
    })
  }, [leads, filters])

  async function handleCreate(values: LeadFormValues) {
    await createMutation.mutateAsync(values)
    setIsCreateOpen(false)
    createMutation.reset()
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Leads"
        description="Todos los leads captados a través de tus formularios, chat con IA e integraciones."
        actions={
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setIsCreateOpen(true)}>
            Nuevo lead
          </Button>
        }
      />

      <LeadFiltersBar filters={filters} onChange={setFilters} teamMembers={teamMembers} />

      {isLoading && (
        <Card className="flex flex-col gap-3 p-5">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-lg bg-slate-800/60" />
          ))}
        </Card>
      )}

      {isError && !isLoading && (
        <EmptyState
          title="No se pudieron cargar los leads"
          description="Ha ocurrido un problema al leer los datos guardados en este navegador."
          action={
            <Button variant="secondary" leftIcon={<RefreshCw className="size-4" />} onClick={() => refetch()}>
              Reintentar
            </Button>
          }
        />
      )}

      {!isLoading && !isError && leads && leads.length === 0 && (
        <EmptyState
          icon={<Users className="size-5" />}
          title="Aún no tienes leads"
          description="Los leads captados desde tus formularios y chat con IA aparecerán aquí. Puedes añadir uno manualmente."
          action={
            <Button leftIcon={<Plus className="size-4" />} onClick={() => setIsCreateOpen(true)}>
              Nuevo lead
            </Button>
          }
        />
      )}

      {!isLoading && !isError && leads && leads.length > 0 && filteredLeads.length === 0 && (
        <EmptyState
          title="No se encontraron leads con estos filtros"
          description="Prueba a ajustar la búsqueda o los filtros aplicados."
          action={
            <Button variant="ghost" onClick={() => setFilters(defaultLeadFilters)}>
              Limpiar filtros
            </Button>
          }
        />
      )}

      {!isLoading && !isError && filteredLeads.length > 0 && (
        <LeadsTable leads={filteredLeads} teamMembers={teamMembers} />
      )}

      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Nuevo lead"
        description="Añade manualmente un lead a tu pipeline de calificación."
      >
        <LeadForm
          mode="create"
          teamMembers={teamMembers}
          onSubmit={handleCreate}
          onCancel={() => setIsCreateOpen(false)}
          isSubmitting={createMutation.isPending}
          submitError={createMutation.isError ? 'No se pudo crear el lead. Inténtalo de nuevo.' : null}
        />
      </Modal>
    </div>
  )
}
