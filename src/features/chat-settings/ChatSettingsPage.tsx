import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, RotateCcw } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { Select } from '@/shared/ui/Select'
import { Textarea } from '@/shared/ui/Textarea'
import { Switch } from '@/shared/ui/Switch'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import {
  CHAT_TONES,
  chatSettingsSchema,
  chatToneLabel,
  createDefaultChatConfiguration,
  useChatConfigQuery,
  useResetChatConfigMutation,
  useSaveChatConfigMutation,
} from '@/entities/chat'
import type { ChatConfiguration, ChatSettingsInput, ChatSettingsValues } from '@/entities/chat'
import { CriteriaEditor } from './components/CriteriaEditor'
import { CollectedInfoEditor } from './components/CollectedInfoEditor'
import { ChatPreview } from './components/ChatPreview'

function toFormValues(config: ChatConfiguration): ChatSettingsInput {
  return {
    assistantName: config.assistantName,
    welcomeMessage: config.welcomeMessage,
    agencyDescription: config.agencyDescription,
    servicesOffered: config.servicesOffered,
    tone: config.tone,
    language: config.language,
    questionsToCollect: config.questionsToCollect.map((value) => ({ id: crypto.randomUUID(), value })),
    criteria: config.criteria,
    minQualifiedScore: config.minQualifiedScore,
    additionalInstructions: config.additionalInstructions ?? '',
    isActive: config.isActive,
  }
}

export function ChatSettingsPage() {
  const { data: config, isLoading } = useChatConfigQuery()
  const saveMutation = useSaveChatConfigMutation()
  const resetMutation = useResetChatConfigMutation()
  const [isResetOpen, setIsResetOpen] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // `toFormValues` mints a fresh crypto.randomUUID() per question-to-collect
  // item, so it must never be called inline in `values` below — that would
  // hand react-hook-form a new object identity every render and its
  // internal effect would call reset() -> re-render -> new object -> reset()
  // forever ("Maximum update depth exceeded"). Memoizing on `config` keeps
  // the reference stable across renders that don't actually change the data.
  const formValues = useMemo(() => (config ? toFormValues(config) : undefined), [config])
  // organizationId is irrelevant here — toFormValues() never reads it, this
  // call only exists to derive react-hook-form's placeholder defaultValues
  // before the real config has loaded.
  const defaultFormValues = useMemo(() => toFormValues(createDefaultChatConfiguration('')), [])

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ChatSettingsInput, unknown, ChatSettingsValues>({
    resolver: zodResolver(chatSettingsSchema),
    values: formValues,
    defaultValues: defaultFormValues,
  })

  const watchedAssistantName = watch('assistantName')
  const watchedWelcomeMessage = watch('welcomeMessage')
  const watchedTone = watch('tone')
  const watchedIsActive = watch('isActive')

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-slate-800/60" />
        <div className="h-96 animate-pulse rounded-xl bg-slate-800/60" />
      </div>
    )
  }

  async function handleSave(values: ChatSettingsValues) {
    setSaveSuccess(false)
    await saveMutation.mutateAsync({
      assistantName: values.assistantName,
      welcomeMessage: values.welcomeMessage,
      agencyDescription: values.agencyDescription,
      servicesOffered: values.servicesOffered,
      tone: values.tone,
      language: values.language,
      questionsToCollect: values.questionsToCollect.map((item) => item.value.trim()).filter(Boolean),
      criteria: values.criteria,
      minQualifiedScore: values.minQualifiedScore,
      additionalInstructions: values.additionalInstructions,
      isActive: values.isActive,
      updatedAt: new Date().toISOString(),
    })
    setSaveSuccess(true)
  }

  async function handleResetConfirm() {
    const defaults = await resetMutation.mutateAsync()
    reset(toFormValues(defaults))
    setIsResetOpen(false)
    setSaveSuccess(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Configuración del chat"
        description="Configura cómo el asistente de Lead AI califica a los leads en conversación."
        actions={
          <Button
            variant="outline"
            size="sm"
            leftIcon={<RotateCcw className="size-4" />}
            onClick={() => setIsResetOpen(true)}
          >
            Restablecer valores predeterminados
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <form onSubmit={handleSubmit(handleSave)} noValidate className="flex flex-col gap-6 lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Identidad y tono</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Chat público activo</p>
                  <p className="text-xs text-slate-500">Controla si /c/vertice-agency acepta conversaciones.</p>
                </div>
                <Switch
                  checked={watchedIsActive}
                  onCheckedChange={(checked) => setValue('isActive', checked, { shouldDirty: true })}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Nombre del asistente *"
                  placeholder="Asistente de Vértice"
                  error={errors.assistantName?.message}
                  {...register('assistantName')}
                />
                <Select label="Tono *" error={errors.tone?.message} {...register('tone')}>
                  {CHAT_TONES.map((tone) => (
                    <option key={tone} value={tone}>
                      {chatToneLabel[tone]}
                    </option>
                  ))}
                </Select>
                <Input label="Idioma *" placeholder="Español" error={errors.language?.message} {...register('language')} />
                <Input
                  label="Puntuación mínima para calificado *"
                  type="number"
                  min={0}
                  max={100}
                  error={errors.minQualifiedScore?.message}
                  {...register('minQualifiedScore')}
                />
                <Textarea
                  label="Mensaje de bienvenida *"
                  placeholder="¡Hola! ¿En qué puedo ayudarte hoy?"
                  className="sm:col-span-2"
                  error={errors.welcomeMessage?.message}
                  {...register('welcomeMessage')}
                />
                <Textarea
                  label="Descripción de la agencia"
                  placeholder="¿A qué se dedica tu agencia?"
                  className="sm:col-span-2"
                  error={errors.agencyDescription?.message}
                  {...register('agencyDescription')}
                />
                <Textarea
                  label="Servicios ofrecidos"
                  placeholder="Marketing digital, SEO, automatización…"
                  className="sm:col-span-2"
                  error={errors.servicesOffered?.message}
                  {...register('servicesOffered')}
                />
                <Textarea
                  label="Instrucciones adicionales (opcional)"
                  placeholder="Cualquier matiz extra que el asistente deba tener en cuenta."
                  className="sm:col-span-2"
                  error={errors.additionalInstructions?.message}
                  {...register('additionalInstructions')}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Información a recopilar</CardTitle>
            </CardHeader>
            <CardContent>
              <CollectedInfoEditor control={control} register={register} errors={errors} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Criterios de calificación</CardTitle>
            </CardHeader>
            <CardContent>
              <CriteriaEditor control={control} register={register} errors={errors} />
            </CardContent>
          </Card>

          {saveMutation.isError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="size-4 shrink-0" />
              No se pudo guardar la configuración. Inténtalo de nuevo.
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            {saveSuccess && !saveMutation.isPending && (
              <p className="text-sm text-emerald-400">Configuración guardada.</p>
            )}
            <Button type="submit" isLoading={saveMutation.isPending}>
              Guardar cambios
            </Button>
          </div>
        </form>

        <div className="lg:col-span-2">
          <ChatPreview
            assistantName={watchedAssistantName}
            welcomeMessage={watchedWelcomeMessage}
            tone={watchedTone}
            isActive={watchedIsActive}
          />
        </div>
      </div>

      <ConfirmDialog
        isOpen={isResetOpen}
        title="Restablecer configuración"
        description="Esto reemplazará la configuración actual del chat con los valores predeterminados. Esta acción no se puede deshacer."
        confirmLabel="Restablecer"
        cancelLabel="Cancelar"
        isConfirming={resetMutation.isPending}
        onConfirm={handleResetConfirm}
        onCancel={() => setIsResetOpen(false)}
      />
    </div>
  )
}
