import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Percent, Star, Users } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent } from '@/shared/ui/Card'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Button } from '@/shared/ui/Button'
import { useFormQuery, useSubmissionsQuery } from '@/entities/form'
import { useLeadsQuery } from '@/entities/lead'
import { FormSubmissionTable } from './components/FormSubmissionTable'

export function FormSubmissionsPage() {
  const { formId } = useParams<{ formId: string }>()
  const { data: form, isLoading: isFormLoading } = useFormQuery(formId)
  const { data: submissions, isLoading: isSubmissionsLoading, isError, refetch } = useSubmissionsQuery(formId)
  const { data: leads } = useLeadsQuery()

  const isLoading = isFormLoading || isSubmissionsLoading

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-6 w-40 animate-pulse rounded-lg bg-slate-800/60" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-800/60" />
      </div>
    )
  }

  if (isError) {
    return (
      <EmptyState
        title="No se pudieron cargar los envíos"
        description="Ha ocurrido un problema al leer los datos guardados en este navegador."
        action={
          <Button variant="secondary" onClick={() => refetch()}>
            Reintentar
          </Button>
        }
      />
    )
  }

  if (!form) {
    return (
      <EmptyState
        title="Formulario no encontrado"
        description="Este formulario no existe o puede haber sido eliminado."
        action={
          <Link to="/forms" className="text-sm font-medium text-blue-400 hover:text-blue-300">
            ← Volver a formularios
          </Link>
        }
      />
    )
  }

  const list = submissions ?? []
  const total = list.length
  const averageScore = total === 0 ? 0 : Math.round(list.reduce((sum, submission) => sum + submission.score, 0) / total)
  const qualifiedPct = total === 0 ? 0 : Math.round((list.filter((submission) => submission.score >= 70).length / total) * 100)

  return (
    <div className="flex flex-col gap-6">
      <Link to="/forms" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-400 hover:text-slate-200">
        <ArrowLeft className="size-4" />
        Volver a formularios
      </Link>

      <PageHeader title={form.name} description="Resultados y envíos de este formulario." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
              <Users className="size-4" />
            </span>
            <p className="mt-4 text-2xl font-semibold text-white">{total}</p>
            <p className="text-sm text-slate-400">Envíos totales</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
              <Star className="size-4" />
            </span>
            <p className="mt-4 text-2xl font-semibold text-white">{total === 0 ? '—' : averageScore}</p>
            <p className="text-sm text-slate-400">Puntuación media</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
              <Percent className="size-4" />
            </span>
            <p className="mt-4 text-2xl font-semibold text-white">{total === 0 ? '—' : `${qualifiedPct}%`}</p>
            <p className="text-sm text-slate-400">Leads calificados</p>
          </CardContent>
        </Card>
      </div>

      {total === 0 ? (
        <EmptyState
          title="Todavía no hay envíos"
          description="Comparte el enlace público de este formulario para empezar a recibir respuestas."
        />
      ) : (
        <FormSubmissionTable submissions={list} leads={leads ?? []} />
      )}
    </div>
  )
}
