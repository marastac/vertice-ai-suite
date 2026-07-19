import { Search } from 'lucide-react'
import { Input } from '@/shared/ui/Input'
import { Select } from '@/shared/ui/Select'
import { Button } from '@/shared/ui/Button'
import type { TeamMember } from '@/entities/team-member'
import { LEAD_SOURCES, LEAD_STATUSES, leadSourceLabel, leadStatusLabel } from '@/entities/lead'
import { defaultLeadFilters } from '../lead-filters'
import type { LeadFilters, LeadSortOption } from '../lead-filters'

interface LeadFiltersBarProps {
  filters: LeadFilters
  onChange: (filters: LeadFilters) => void
  teamMembers: TeamMember[]
}

export function LeadFiltersBar({ filters, onChange, teamMembers }: LeadFiltersBarProps) {
  function set<K extends keyof LeadFilters>(key: K, value: LeadFilters[K]) {
    onChange({ ...filters, [key]: value })
  }

  const isFiltered =
    filters.search !== '' ||
    filters.status !== 'all' ||
    filters.source !== 'all' ||
    filters.assignedTo !== 'all' ||
    filters.scoreMin !== '' ||
    filters.scoreMax !== '' ||
    filters.sort !== 'newest'

  return (
    <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Input
        aria-label="Buscar leads"
        placeholder="Buscar por nombre, empresa o correo…"
        leftIcon={<Search className="size-4" />}
        value={filters.search}
        onChange={(event) => set('search', event.target.value)}
        className="lg:col-span-2"
      />
      <Select
        aria-label="Filtrar por estado"
        value={filters.status}
        onChange={(event) => set('status', event.target.value)}
      >
        <option value="all">Todos los estados</option>
        {LEAD_STATUSES.map((status) => (
          <option key={status} value={status}>
            {leadStatusLabel[status]}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Filtrar por fuente"
        value={filters.source}
        onChange={(event) => set('source', event.target.value)}
      >
        <option value="all">Todas las fuentes</option>
        {LEAD_SOURCES.map((source) => (
          <option key={source} value={source}>
            {leadSourceLabel[source]}
          </option>
        ))}
      </Select>
      <Input
        aria-label="Puntuación mínima"
        type="number"
        min={0}
        max={100}
        placeholder="Puntuación mín."
        value={filters.scoreMin}
        onChange={(event) => set('scoreMin', event.target.value)}
      />
      <Input
        aria-label="Puntuación máxima"
        type="number"
        min={0}
        max={100}
        placeholder="Puntuación máx."
        value={filters.scoreMax}
        onChange={(event) => set('scoreMax', event.target.value)}
      />
      <Select
        aria-label="Filtrar por persona asignada"
        value={filters.assignedTo}
        onChange={(event) => set('assignedTo', event.target.value)}
      >
        <option value="all">Todas las personas</option>
        <option value="unassigned">Sin asignar</option>
        {teamMembers.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Ordenar leads"
        value={filters.sort}
        onChange={(event) => set('sort', event.target.value as LeadSortOption)}
      >
        <option value="newest">Más recientes</option>
        <option value="oldest">Más antiguos</option>
        <option value="score-desc">Puntuación más alta</option>
        <option value="score-asc">Puntuación más baja</option>
      </Select>

      {isFiltered && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(defaultLeadFilters)}
          className="justify-self-start"
        >
          Limpiar filtros
        </Button>
      )}
    </div>
  )
}
