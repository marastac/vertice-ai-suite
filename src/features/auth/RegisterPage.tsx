import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Lock, Mail, MailCheck, User } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { registerSchema, useAuth } from '@/entities/auth'
import type { RegisterValues } from '@/entities/auth'
import { AuthLayout } from './components/AuthLayout'
import { SupabaseNotConfiguredNotice } from './components/SupabaseNotConfiguredNotice'

export function RegisterPage() {
  const { signUp, isSupabaseConfigured, user } = useAuth()
  const navigate = useNavigate()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [confirmationSent, setConfirmationSent] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: '', email: '', password: '', confirmPassword: '' },
  })

  if (user) {
    return <Navigate to="/dashboard" replace />
  }

  if (confirmationSent) {
    return (
      <AuthLayout title="Revisa tu correo">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <MailCheck className="size-10 text-blue-400" />
          <p className="text-sm text-slate-300">
            Te hemos enviado un enlace de confirmación. Ábrelo para activar tu cuenta y después inicia sesión.
          </p>
          <Link to="/login" className="text-sm font-medium text-blue-400 hover:text-blue-300">
            Volver a inicio de sesión
          </Link>
        </div>
      </AuthLayout>
    )
  }

  const onSubmit = async (values: RegisterValues) => {
    setSubmitError(null)
    setIsSubmitting(true)
    const { error, needsEmailConfirmation } = await signUp(values.email, values.password, values.fullName)
    setIsSubmitting(false)
    if (error) {
      setSubmitError(error)
      return
    }
    if (needsEmailConfirmation) {
      setConfirmationSent(true)
      return
    }
    navigate('/dashboard', { replace: true })
  }

  return (
    <AuthLayout
      title="Crea tu cuenta"
      description="Empieza a calificar leads con Lead AI"
      footer={
        <span className="text-slate-400">
          ¿Ya tienes cuenta?{' '}
          <Link to="/login" className="font-medium text-blue-400 hover:text-blue-300">
            Inicia sesión
          </Link>
        </span>
      }
    >
      {!isSupabaseConfigured && <SupabaseNotConfiguredNotice />}

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <Input
          label="Nombre completo"
          autoComplete="name"
          placeholder="Ana Torres"
          leftIcon={<User className="size-4" />}
          error={errors.fullName?.message}
          disabled={!isSupabaseConfigured}
          {...register('fullName')}
        />
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
        <Input
          label="Contraseña"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          leftIcon={<Lock className="size-4" />}
          error={errors.password?.message}
          disabled={!isSupabaseConfigured}
          {...register('password')}
        />
        <Input
          label="Confirmar contraseña"
          type="password"
          autoComplete="new-password"
          placeholder="••••••••"
          leftIcon={<Lock className="size-4" />}
          error={errors.confirmPassword?.message}
          disabled={!isSupabaseConfigured}
          {...register('confirmPassword')}
        />

        {submitError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            {submitError}
          </div>
        )}

        <Button type="submit" isLoading={isSubmitting} disabled={!isSupabaseConfigured} className="w-full">
          Crear cuenta
        </Button>
      </form>
    </AuthLayout>
  )
}
