import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Mail, Lock } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { loginSchema, useAuth } from '@/entities/auth'
import type { LoginValues } from '@/entities/auth'
import { AuthLayout } from './components/AuthLayout'
import { SupabaseNotConfiguredNotice } from './components/SupabaseNotConfiguredNotice'

interface LocationState {
  from?: { pathname: string }
}

// Top-level segments actually registered under the AppShell tree in
// router.tsx. ProtectedRoute stores whatever path a logged-out visit hit
// into location.state.from, and this page redirects back there on
// successful login — but that path was never validated against the real
// route table. A stale/bogus from.pathname (a dead bookmark, a typo, a
// browser-suggested URL — anything that isn't one of ours) would otherwise
// send a freshly-logged-in user straight back to a 404, forever, since
// nothing ever clears state.from. Falling back to /dashboard for anything
// not on this list is what actually fixes that, regardless of how the bad
// path got captured in the first place.
const KNOWN_APP_PATH_PREFIXES = [
  '/dashboard',
  '/leads',
  '/forms',
  '/conversations',
  '/chat-settings',
  '/integrations',
  '/team',
  '/settings',
  '/onboarding',
]

function resolveRedirectTarget(from: string | undefined): string {
  if (from && KNOWN_APP_PATH_PREFIXES.some((prefix) => from === prefix || from.startsWith(`${prefix}/`))) {
    return from
  }
  return '/dashboard'
}

export function LoginPage() {
  const { signIn, isSupabaseConfigured, user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  if (user) {
    const from = (location.state as LocationState | null)?.from?.pathname
    return <Navigate to={resolveRedirectTarget(from)} replace />
  }

  const onSubmit = async (values: LoginValues) => {
    setSubmitError(null)
    setIsSubmitting(true)
    const { error } = await signIn(values.email, values.password)
    setIsSubmitting(false)
    if (error) {
      setSubmitError(error)
      return
    }
    const from = (location.state as LocationState | null)?.from?.pathname
    navigate(resolveRedirectTarget(from), { replace: true })
  }

  return (
    <AuthLayout
      title="Inicia sesión"
      description="Accede al panel de Lead AI"
      footer={
        <span className="text-slate-400">
          ¿No tienes cuenta?{' '}
          <Link to="/register" className="font-medium text-blue-400 hover:text-blue-300">
            Regístrate
          </Link>
        </span>
      }
    >
      {!isSupabaseConfigured && <SupabaseNotConfiguredNotice />}

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <Input
          label="Correo electrónico"
          type="email"
          autoComplete="email"
          placeholder="tucorreo@empresa.com"
          leftIcon={<Mail className="size-4" />}
          error={errors.email?.message}
          disabled={!isSupabaseConfigured}
          {...register('email')}
        />
        <div className="flex flex-col gap-1.5">
          <Input
            label="Contraseña"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            leftIcon={<Lock className="size-4" />}
            error={errors.password?.message}
            disabled={!isSupabaseConfigured}
            {...register('password')}
          />
          <div className="flex justify-end">
            <Link to="/forgot-password" className="text-xs text-blue-400 hover:text-blue-300">
              ¿Olvidaste tu contraseña?
            </Link>
          </div>
        </div>

        {submitError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            {submitError}
          </div>
        )}

        <Button type="submit" isLoading={isSubmitting} disabled={!isSupabaseConfigured} className="w-full">
          Iniciar sesión
        </Button>
      </form>
    </AuthLayout>
  )
}
