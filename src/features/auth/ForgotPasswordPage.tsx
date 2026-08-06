import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Mail, MailCheck } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { forgotPasswordSchema, useAuth } from '@/entities/auth'
import type { ForgotPasswordValues } from '@/entities/auth'
import { AuthLayout } from './components/AuthLayout'
import { SupabaseNotConfiguredNotice } from './components/SupabaseNotConfiguredNotice'

export function ForgotPasswordPage() {
  const { sendPasswordReset, isSupabaseConfigured } = useAuth()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [emailSent, setEmailSent] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  })

  if (emailSent) {
    return (
      <AuthLayout title="Correo enviado">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <MailCheck className="size-10 text-blue-400" />
          <p className="text-sm text-slate-300">
            Si existe una cuenta con ese correo, te hemos enviado un enlace para restablecer tu contraseña.
          </p>
          <Link to="/login" className="text-sm font-medium text-blue-400 hover:text-blue-300">
            Volver a inicio de sesión
          </Link>
        </div>
      </AuthLayout>
    )
  }

  const onSubmit = async (values: ForgotPasswordValues) => {
    setSubmitError(null)
    setIsSubmitting(true)
    const { error } = await sendPasswordReset(values.email)
    setIsSubmitting(false)
    if (error) {
      setSubmitError(error)
      return
    }
    setEmailSent(true)
  }

  return (
    <AuthLayout
      title="Recupera tu contraseña"
      description="Te enviaremos un enlace para restablecerla"
      footer={
        <span className="text-slate-400">
          <Link to="/login" className="font-medium text-blue-400 hover:text-blue-300">
            Volver a inicio de sesión
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

        {submitError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            {submitError}
          </div>
        )}

        <Button type="submit" isLoading={isSubmitting} disabled={!isSupabaseConfigured} className="w-full">
          Enviar enlace de recuperación
        </Button>
      </form>
    </AuthLayout>
  )
}
