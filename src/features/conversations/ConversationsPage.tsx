import { useMemo, useState } from 'react'
import { MessagesSquare, RefreshCw, Search } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card } from '@/shared/ui/Card'
import { Input } from '@/shared/ui/Input'
import { Select } from '@/shared/ui/Select'
import { Button } from '@/shared/ui/Button'
import { EmptyState } from '@/shared/ui/EmptyState'
import { chatQualificationStatusLabel, useChatSessionsQuery } from '@/entities/chat'
import { useOrganization } from '@/entities/organization'
import { ConversationsTable } from './components/ConversationsTable'
import { defaultConversationFilters } from './conversation-filters'
import type { ConversationFilters, ConversationStatusFilter } from './conversation-filters'

export function ConversationsPage() {
  const { organization } = useOrganization()
  const { data: sessions, isLoading, isError, refetch } = useChatSessionsQuery()
  const [filters, setFilters] = useState<ConversationFilters>(defaultConversationFilters)

  const filteredSessions = useMemo(() => {
    if (!sessions) return []
    const search = filters.search.trim().toLowerCase()

    return [...sessions]
      .filter((session) => {
        const contactName = session.qualification?.contactName ?? ''
        const email = session.qualification?.email ?? ''
        const matchesSearch =
          search === '' ||
          contactName.toLowerCase().includes(search) ||
          email.toLowerCase().includes(search) ||
          session.assistantName.toLowerCase().includes(search)

        const matchesStatus =
          filters.status === 'all' ||
          (filters.status === 'pending' ? !session.qualification : session.qualification?.status === filters.status)

        return matchesSearch && matchesStatus
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [sessions, filters])

  const isFiltered = filters.search !== '' || filters.status !== 'all'

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Conversaciones"
        description="Conversaciones del chat con IA y su calificación resultante."
      />

      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          aria-label="Buscar conversaciones"
          placeholder="Buscar por nombre o correo…"
          leftIcon={<Search className="size-4" />}
          value={filters.search}
          onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
          className="lg:col-span-2"
        />
        <Select
          aria-label="Filtrar por estado"
          value={filters.status}
          onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value as ConversationStatusFilter }))}
        >
          <option value="all">Todos los estados</option>
          <option value="pending">En curso</option>
          {(['disqualified', 'qualifying', 'qualified'] as const).map((status) => (
            <option key={status} value={status}>
              {chatQualificationStatusLabel[status]}
            </option>
          ))}
        </Select>
        {isFiltered && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setFilters(defaultConversationFilters)}
            className="justify-self-start"
          >
            Limpiar filtros
          </Button>
        )}
      </div>

      {isLoading && (
        <Card className="flex flex-col gap-3 p-5">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-lg bg-slate-800/60" />
          ))}
        </Card>
      )}

      {isError && !isLoading && (
        <EmptyState
          title="No se pudieron cargar las conversaciones"
          description="Ha ocurrido un problema al leer los datos guardados en este navegador."
          action={
            <Button variant="secondary" leftIcon={<RefreshCw className="size-4" />} onClick={() => refetch()}>
              Reintentar
            </Button>
          }
        />
      )}

      {!isLoading && !isError && sessions && sessions.length === 0 && (
        <EmptyState
          icon={<MessagesSquare className="size-5" />}
          title="Todavía no hay conversaciones"
          description={`Cuando un visitante hable con el chat con IA en /c/${organization?.slug ?? '…'}, aparecerá aquí.`}
        />
      )}

      {!isLoading && !isError && sessions && sessions.length > 0 && filteredSessions.length === 0 && (
        <EmptyState
          title="No se encontraron conversaciones con estos filtros"
          description="Prueba a ajustar la búsqueda o el filtro de estado."
          action={
            <Button variant="ghost" onClick={() => setFilters(defaultConversationFilters)}>
              Limpiar filtros
            </Button>
          }
        />
      )}

      {!isLoading && !isError && filteredSessions.length > 0 && <ConversationsTable sessions={filteredSessions} />}
    </div>
  )
}
