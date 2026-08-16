import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Check, Copy, Link2, Percent, Star, Users } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent } from '@/shared/ui/Card'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Button } from '@/shared/ui/Button'
import { getPublicFormUrl, useFormQuery, useSubmissionsQuery } from '@/entities/form'
import { useLeadsQuery } from '@/entities/lead'
import { FormSubmissionTable } from './components/FormSubmissionTable'

export function FormSubmissionsPage() {
  const { formId } = useParams<{ formId: string }>()
  const { data: form, isLoading: isFormLoading } = useFormQuery(formId)
  const { data: submissions, isLoading: isSubmissionsLoading, isError, refetch } = useSubmissionsQuery(formId)
  const { data: leads } = useLeadsQuery()
  const [copied, setCopied] = useState(false)

  const isLoading = isFormLoading || isSubmissionsLoading

  async function handleCopyLink() {
    if (!form || form.status !== 'active') return
    await navigator.clipboard.writeText(getPublicFormUrl(form.id))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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

      <PageHeader
        title={form.name}
        description="Resultados y envíos de este formulario."
        actions={
          form.status === 'active' ? (
            <Button
              variant="secondary"
              leftIcon={copied ? <Check className="size-4 text-emerald-400" /> : <Link2 className="size-4" />}
              onClick={handleCopyLink}
            >
              {copied ? 'Enlace copiado' : 'Copiar enlace público'}
            </Button>
          ) : (
            <span className="text-xs text-slate-500">Activa el formulario para poder compartir su enlace público.</span>
          )
        }
      />

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
          description={
            form.status === 'active'
              ? 'Comparte el enlace público de este formulario para empezar a recibir respuestas.'
              : 'Este formulario está en borrador. Actívalo desde "Formularios" para poder compartir su enlace público.'
          }
          action={
            form.status === 'active' ? (
              <div className="flex items-center gap-2">
                <code className="rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300">
                  {getPublicFormUrl(form.id)}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Copiar enlace público"
                  onClick={handleCopyLink}
                >
                  {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <FormSubmissionTable submissions={list} leads={leads ?? []} />
      )}
    </div>
  )
}
