import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Check, CheckCircle2, Copy, KeyRound, RefreshCw } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { Modal } from '@/shared/ui/Modal'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { Switch } from '@/shared/ui/Switch'
import {
  useRegenerateWebhookSecretMutation,
  useSaveWebhookConfigMutation,
  useTestWebhookMutation,
  useWebhookConfigQuery,
  webhookConfigSchema,
} from '@/entities/webhook'
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
  const regenerateMutation = useRegenerateWebhookSecretMutation()
  const [testFeedback, setTestFeedback] = useState<TestFeedback | null>(null)
  // Holds a secret ONLY for as long as this modal session has it to show —
  // never written to localStorage/sessionStorage/any persistent store, and
  // never part of a TanStack Query cache (saveWebhookConfig()/
  // regenerateWebhookSecret() return it directly to this component, not
  // through a cached query). Cleared on every path that closes this modal
  // (handleClose below) — once gone, there is no way to get it back short
  // of regenerating again, which is the intended behavior.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)
  const [isRegenerateConfirmOpen, setIsRegenerateConfirmOpen] = useState(false)

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
    regenerateMutation.reset()
    setTestFeedback(null)
    setRevealedSecret(null)
    setSecretCopied(false)
    setIsRegenerateConfirmOpen(false)
    onClose()
  }

  async function onSubmit(values: WebhookConfigValues) {
    setTestFeedback(null)
    const result = await saveMutation.mutateAsync(values)
    // Only the very first save (creating the configuration) returns a
    // secret — see saveWebhookConfig()'s doc comment. A later save that
    // only edits url/isActive returns none; in that case a secret
    // revealed earlier in this same modal session is deliberately left
    // showing rather than cleared, since the user already has legitimate
    // access to it from moments ago.
    if (result.secret) {
      setRevealedSecret(result.secret)
      setSecretCopied(false)
    }
  }

  async function handleCopySecret() {
    if (!revealedSecret) return
    await navigator.clipboard.writeText(revealedSecret)
    setSecretCopied(true)
    setTimeout(() => setSecretCopied(false), 2000)
  }

  async function handleConfirmRegenerate() {
    const result = await regenerateMutation.mutateAsync()
    setRevealedSecret(result.secret)
    setSecretCopied(false)
    setIsRegenerateConfirmOpen(false)
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
        <div className="flex flex-col gap-4">
          {revealedSecret && (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-100">
              <div className="flex items-center gap-2 font-semibold text-amber-200">
                <KeyRound className="size-4 shrink-0" />
                Secreto de firma
              </div>
              <p>Guárdalo ahora. Por seguridad, no podrás volver a verlo después de cerrar esta ventana.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-amber-500/20 bg-black/30 px-2 py-1.5 font-mono text-xs whitespace-nowrap text-amber-50">
                  {revealedSecret}
                </code>
                <Button type="button" variant="outline" size="sm" onClick={handleCopySecret} aria-label="Copiar secreto">
                  {secretCopied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                </Button>
              </div>
            </div>
          )}

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

          {config && (
            <div className="flex flex-col gap-2 border-t border-slate-800 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">Secreto perdido o comprometido</p>
                  <p className="text-xs text-slate-400">
                    Por seguridad, el secreto actual no puede volver a mostrarse — solo puedes generar uno nuevo.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsRegenerateConfirmOpen(true)}
                  isLoading={regenerateMutation.isPending}
                >
                  <RefreshCw className="mr-1.5 size-3.5" />
                  Regenerar secreto
                </Button>
              </div>
              {regenerateMutation.isError && (
                <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  <AlertCircle className="size-4 shrink-0" />
                  {regenerateMutation.error instanceof Error ? regenerateMutation.error.message : 'No se pudo regenerar el secreto.'}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-3 text-xs text-slate-400">
            <p className="font-medium text-slate-300">Cómo verificar la firma en tu servidor</p>
            <p>
              Cada entrega incluye el header <code className="rounded bg-black/30 px-1 py-0.5 text-slate-200">X-LeadAI-Signature</code>{' '}
              con el formato <code className="rounded bg-black/30 px-1 py-0.5 text-slate-200">sha256=&lt;firma&gt;</code>.
            </p>
            <p>La firma es un HMAC-SHA256 del cuerpo HTTP recibido, calculado con el secreto de este webhook.</p>
            <p>Verifícala usando el cuerpo RAW exacto que recibiste — no una versión reserializada del JSON.</p>
            <p>
              Usa el header <code className="rounded bg-black/30 px-1 py-0.5 text-slate-200">X-LeadAI-Delivery</code> como identificador
              de idempotencia: una misma entrega puede repetirse (modelo de entrega "al menos una vez"), así que deduplica por ese valor
              antes de procesarla.
            </p>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={isRegenerateConfirmOpen}
        title="Regenerar secreto"
        description="El secreto anterior dejará de funcionar inmediatamente. Cualquier integración que lo use dejará de poder verificar nuevas entregas hasta que actualices el nuevo secreto."
        confirmLabel="Regenerar"
        variant="danger"
        isConfirming={regenerateMutation.isPending}
        onConfirm={handleConfirmRegenerate}
        onCancel={() => setIsRegenerateConfirmOpen(false)}
      />
    </Modal>
  )
}
