import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { Modal } from '@/shared/ui/Modal'
import { Switch } from '@/shared/ui/Switch'
import { useSaveWebhookConfigMutation, useTestWebhookMutation, useWebhookConfigQuery, webhookConfigSchema } from '@/entities/webhook'
import type { WebhookConfigValues } from '@/entities/webhook'

interface WebhookConfigModalProps {
  isOpen: boolean
  onClose: () => void
}

interface TestFeedback {
  success: boolean
  message: string
}

export function WebhookConfigModal({ isOpen, onClose }: WebhookConfigModalProps) {
  const { data: config, isLoading, isError } = useWebhookConfigQuery()
  const saveMutation = useSaveWebhookConfigMutation()
  const testMutation = useTestWebhookMutation()
  const [testFeedback, setTestFeedback] = useState<TestFeedback | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<WebhookConfigValues>({
    resolver: zodResolver(webhookConfigSchema),
    // Same `values` (not `defaultValues`) pattern as ChatSettingsPage/SettingsPage
    // — keeps the form in sync once the query resolves, and resets isDirty
    // back to false automatically right after a successful save.
    values: config ? { url: config.url, isActive: config.isActive } : undefined,
    defaultValues: { url: '', isActive: false },
  })

  const watchedIsActive = watch('isActive')

  function handleClose() {
    saveMutation.reset()
    testMutation.reset()
    setTestFeedback(null)
    onClose()
  }

  async function onSubmit(values: WebhookConfigValues) {
    setTestFeedback(null)
    await saveMutation.mutateAsync(values)
  }

  async function handleTest() {
    setTestFeedback(null)
    try {
      const result = await testMutation.mutateAsync()
      if (result.success) {
        setTestFeedback({ success: true, message: `Entrega de prueba enviada correctamente (código ${result.responseStatus}).` })
      } else {
        const statusPart = result.responseStatus ? `, código ${result.responseStatus}` : ''
        setTestFeedback({ success: false, message: `No se pudo entregar la prueba (${result.errorReason ?? 'error desconocido'}${statusPart}).` })
      }
    } catch (error) {
      // Network/timeout failure calling our own backend (not the webhook
      // destination itself) — distinct from a webhook delivery failure,
      // but shown the same way since both mean "the test didn't succeed".
      setTestFeedback({ success: false, message: error instanceof Error ? error.message : 'No se pudo probar el webhook.' })
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Configurar Webhook"
      description="Recibe una notificación HTTP firmada cada vez que se cree un nuevo lead."
    >
      {isLoading ? (
        <div className="h-32 animate-pulse rounded-lg bg-slate-800/60" />
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertCircle className="size-4 shrink-0" />
          No se pudo cargar la configuración. Inténtalo de nuevo.
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <Input
            label="URL del endpoint *"
            placeholder="https://tu-servidor.com/webhooks/lead-ai"
            hint="Debe ser una URL HTTPS pública — no se admiten direcciones internas o privadas."
            error={errors.url?.message}
            {...register('url')}
          />
          <Switch
            checked={watchedIsActive}
            onCheckedChange={(checked) => setValue('isActive', checked, { shouldDirty: true })}
            label="Webhook activo"
          />

          {saveMutation.isError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="size-4 shrink-0" />
              {saveMutation.error instanceof Error ? saveMutation.error.message : 'No se pudo guardar la configuración.'}
            </div>
          )}
          {saveMutation.isSuccess && !isDirty && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-400">
              <CheckCircle2 className="size-4 shrink-0" />
              Configuración guardada.
            </p>
          )}

          {testFeedback && (
            <div
              className={
                testFeedback.success
                  ? 'flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300'
                  : 'flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300'
              }
            >
              {testFeedback.success ? (
                <CheckCircle2 className="size-4 shrink-0" />
              ) : (
                <AlertCircle className="size-4 shrink-0" />
              )}
              {testFeedback.message}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTest}
              isLoading={testMutation.isPending}
              disabled={!config || isDirty}
              title={!config ? 'Guarda una URL primero.' : isDirty ? 'Guarda los cambios antes de probar.' : undefined}
            >
              Probar webhook
            </Button>
            <div className="flex gap-3">
              <Button type="button" variant="ghost" onClick={handleClose}>
                Cerrar
              </Button>
              <Button type="submit" isLoading={saveMutation.isPending} disabled={!isDirty}>
                Guardar cambios
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  )
}
