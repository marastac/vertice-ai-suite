import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { AlertCircle, GraduationCap, ShoppingBag, Sparkles, Video } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { BUSINESS_TYPES, businessTypeDescription, businessTypeLabel, useOrganization } from '@/entities/organization'
import type { BusinessType } from '@/entities/organization'
import { BusinessTypeCard } from './components/BusinessTypeCard'

const businessTypeIcon: Record<BusinessType, LucideIcon> = {
  content_creator: Video,
  course_creator: GraduationCap,
  online_business: ShoppingBag,
}

export function OnboardingPage() {
  const { organization, completeOnboarding } = useOrganization()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<BusinessType | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Already set up (e.g. revisited via a bookmark, or the back button) —
  // nothing to do here, go straight to the dashboard.
  if (organization?.onboardingCompletedAt) {
    return <Navigate to="/dashboard" replace />
  }

  async function handleContinue() {
    if (!selected) return
    setError(null)
    setIsSubmitting(true)
    try {
      await completeOnboarding(selected)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo completar la configuración. Inténtalo de nuevo.')
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-vertice-bg px-4 py-12 text-slate-100">
      <div className="flex w-full max-w-2xl flex-col items-center gap-2 pb-8">
        <span className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
          <Sparkles className="size-5 text-white" />
        </span>
        <span className="text-base font-semibold text-white">Lead AI</span>
      </div>

      <div className="w-full max-w-2xl">
        <h1 className="text-center text-2xl font-semibold text-white">¡Bienvenido/a a Lead AI!</h1>
        <p className="mx-auto mt-2 max-w-lg text-center text-sm text-slate-400">
          Cuéntanos a qué te dedicas y preparamos tu asistente de chat y un formulario de calificación de ejemplo, listos
          para editar.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {BUSINESS_TYPES.map((type) => (
            <BusinessTypeCard
              key={type}
              icon={businessTypeIcon[type]}
              label={businessTypeLabel[type]}
              description={businessTypeDescription[type]}
              selected={selected === type}
              onSelect={() => setSelected(type)}
            />
          ))}
        </div>

        {error && (
          <div className="mt-6 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="mt-8 flex justify-center">
          <Button onClick={handleContinue} disabled={!selected} isLoading={isSubmitting} size="lg">
            Empezar
          </Button>
        </div>
      </div>
    </div>
  )
}
