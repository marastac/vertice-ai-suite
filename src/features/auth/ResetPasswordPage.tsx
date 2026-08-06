import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, CheckCircle2, Loader2, Lock } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { resetPasswordSchema, useAuth } from '@/entities/auth'
import type { ResetPasswordValues } from '@/entities/auth'
import { AuthLayout } from './components/AuthLayout'
import { SupabaseNotConfiguredNotice } from './components/SupabaseNotConfiguredNotice'

export function ResetPasswordPage() {
  const { updatePassword, isSupabaseConfigured, isLoading, user } = useAuth()
  const navigate = useNavigate()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDone, setIsDone] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  if (isSupabaseConfigured && isLoading) {
    return (
      <AuthLayout title="Restablecer contraseña">
        <div className="flex justify-center py-6">
          <Loader2 className="size-6 animate-spin text-slate-400" />
        </div>
      </AuthLayout>
    )
  }

  if (isDone) {
    return (
      <AuthLayout title="Contraseña actualizada">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircle2 className="size-10 text-emerald-400" />
          <p className="text-sm text-slate-300">Tu contraseña se ha actualizado correctamente.</p>
          <Button onClick={() => navigate('/dashboard', { replace: true })}>Ir al panel</Button>
        </div>
      </AuthLayout>
    )
  }

  if (!isSupabaseConfigured) {
    return (
      <AuthLayout title="Restablecer contraseña">
        <SupabaseNotConfiguredNotice />
      </AuthLayout>
    )
  }

  if (!user) {
    return (
      <AuthLayout title="Enlace no válido">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <AlertCircle className="size-10 text-red-400" />
          <p className="text-sm text-slate-300">
            Este enlace de recuperación no es válido o ha expirado. Solicita uno nuevo.
          </p>
          <Link to="/forgot-password" className="text-sm font-medium text-blue-400 hover:text-blue-300">
            Solicitar nuevo enlace
          </Link>
        </div>
      </AuthLayout>
    )
  }

  const onSubmit = async (values: ResetPasswordValues) => {
    setSubmitError(null)
    setIsSubmitting(true)
    const { error } = await updatePassword(values.password)
    setIsSubmitting(false)
    if (error) {
      setSubmitError(error)
      return
    }
    setIsDone(true)
  }

  return (
    <AuthLayout title="Restablecer contraseña" description="Elige una nueva contraseña para tu cuenta">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <Input
          label="Nueva contraseña"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          leftIcon={<Lock className="size-4" />}
          error={errors.password?.message}
          {...register('password')}
        />
        <Input
          label="Confirmar nueva contraseña"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          leftIcon={<Lock className="size-4" />}
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        {submitError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            {submitError}
          </div>
        )}

        <Button type="submit" isLoading={isSubmitting} className="w-full">
          Actualizar contraseña
        </Button>
      </form>
    </AuthLayout>
  )
}
