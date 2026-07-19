import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { MessagesSquare, RefreshCw, Target, TrendingUp, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Button } from '@/shared/ui/Button'
import { leadStatusBadgeVariant, leadStatusLabel, useLeadsQuery } from '@/entities/lead'

interface Stat {
  label: string
  value: string
  icon: LucideIcon
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function DashboardPage() {
  const { data: leads, isLoading, isError, refetch } = useLeadsQuery()

  const stats = useMemo<Stat[]>(() => {
    if (!leads || leads.length === 0) {
      return [
        { label: 'Leads nuevos (7 días)', value: '0', icon: Users },
        { label: 'Tasa de calificación', value: '—', icon: Target },
        { label: 'En proceso de calificación', value: '0', icon: MessagesSquare },
        { label: 'Puntuación media', value: '—', icon: TrendingUp },
      ]
    }

    const now = Date.now()
    const newThisWeek = leads.filter((lead) => now - new Date(lead.createdAt).getTime() <= ONE_WEEK_MS).length
    const qualifiedCount = leads.filter((lead) => lead.status === 'qualified' || lead.status === 'converted').length
    const qualificationRate = Math.round((qualifiedCount / leads.length) * 100)
    const qualifyingCount = leads.filter((lead) => lead.status === 'qualifying').length
    const avgScore = Math.round(leads.reduce((sum, lead) => sum + lead.score, 0) / leads.length)

    return [
      { label: 'Leads nuevos (7 días)', value: String(newThisWeek), icon: Users },
      { label: 'Tasa de calificación', value: `${qualificationRate}%`, icon: Target },
      { label: 'En proceso de calificación', value: String(qualifyingCount), icon: MessagesSquare },
      { label: 'Puntuación media', value: String(avgScore), icon: TrendingUp },
    ]
  }, [leads])

  const recentLeads = useMemo(() => {
    if (!leads) return []
    return [...leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)
  }, [leads])

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Panel" description="Un resumen de tu proceso de calificación de leads." />

      {isError && !isLoading && (
        <EmptyState
          title="No se pudieron cargar los datos"
          description="Ha ocurrido un problema al leer los leads guardados en este navegador."
          action={
            <Button variant="secondary" leftIcon={<RefreshCw className="size-4" />} onClick={() => refetch()}>
              Reintentar
            </Button>
          }
        />
      )}

      {!isError && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {isLoading
              ? Array.from({ length: 4 }).map((_, index) => (
                  <Card key={index}>
                    <CardContent className="pt-5">
                      <div className="h-9 w-9 animate-pulse rounded-lg bg-slate-800/60" />
                      <div className="mt-4 h-7 w-16 animate-pulse rounded bg-slate-800/60" />
                      <div className="mt-2 h-4 w-28 animate-pulse rounded bg-slate-800/60" />
                    </CardContent>
                  </Card>
                ))
              : stats.map((stat) => (
                  <Card key={stat.label}>
                    <CardContent className="pt-5">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
                        <stat.icon className="size-4" />
                      </span>
                      <p className="mt-4 text-2xl font-semibold text-white">{stat.value}</p>
                      <p className="text-sm text-slate-400">{stat.label}</p>
                    </CardContent>
                  </Card>
                ))}
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Leads recientes</CardTitle>
              <Link to="/leads" className="text-sm font-medium text-blue-400 hover:text-blue-300">
                Ver todos
              </Link>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {isLoading &&
                Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="h-12 animate-pulse rounded-lg bg-slate-800/60" />
                ))}

              {!isLoading && recentLeads.length === 0 && (
                <EmptyState
                  title="Aún no tienes leads"
                  description="Los leads que captes aparecerán aquí."
                  action={
                    <Link to="/leads" className="text-sm font-medium text-blue-400 hover:text-blue-300">
                      Ir a Leads
                    </Link>
                  }
                />
              )}

              {!isLoading &&
                recentLeads.map((lead) => (
                  <Link
                    key={lead.id}
                    to={`/leads/${lead.id}`}
                    className="flex items-center justify-between gap-4 rounded-lg px-2 py-3 transition-colors hover:bg-slate-800/60"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-100">{lead.name}</p>
                      <p className="truncate text-xs text-slate-500">{lead.company}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-sm font-semibold text-slate-200">{lead.score}</span>
                      <Badge variant={leadStatusBadgeVariant[lead.status]}>{leadStatusLabel[lead.status]}</Badge>
                    </div>
                  </Link>
                ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
