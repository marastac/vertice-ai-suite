import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Input } from '@/shared/ui/Input'
import { Button } from '@/shared/ui/Button'
import {
  canEditOrganizationSettings,
  organizationSettingsSchema,
  useOrganization,
} from '@/entities/organization'
import type { OrganizationSettingsInput, OrganizationSettingsValues } from '@/entities/organization'

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

export function SettingsPage() {
  const { organization, role, updateSettings } = useOrganization()
  const canEdit = canEditOrganizationSettings(role)

  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isDirty },
  } = useForm<OrganizationSettingsInput, unknown, OrganizationSettingsValues>({
    resolver: zodResolver(organizationSettingsSchema),
    // `values` (not `defaultValues`) keeps the form in sync whenever
    // `organization` changes — including right after a successful save,
    // when updateSettings() patches OrganizationProvider's state with the
    // persisted row. That's also what resets `isDirty` back to false post-save,
    // same mechanism ChatSettingsPage.tsx already relies on.
    values: organization
      ? {
          name: organization.name,
          supportEmail: organization.supportEmail ?? '',
          brandColor: organization.brandColor ?? '',
        }
      : undefined,
    defaultValues: { name: '', supportEmail: '', brandColor: '' },
  })

  // watch('brandColor') is typed `unknown` at the input-schema level (see
  // organizationSettingsSchema's z.preprocess — same pattern/limitation as
  // every other optional field in the app, e.g. entities/lead/schema.ts's
  // emptyToUndefined-based fields). Narrow it here rather than changing
  // that established pattern just for this one preview swatch.
  const watchedBrandColorRaw = watch('brandColor')
  const watchedBrandColor = typeof watchedBrandColorRaw === 'string' ? watchedBrandColorRaw : ''

  async function handleSave(values: OrganizationSettingsValues) {
    // Defense-in-depth alongside the disabled <fieldset> below and the
    // hidden "Guardar cambios" button — organizations_update_members' RLS
    // (is_org_admin(id)) is what actually blocks member/viewer, this just
    // avoids firing a request that would only fail server-side, and avoids
    // saving when nothing actually changed.
    if (!canEdit || !isDirty) return

    setSaveSuccess(false)
    setSaveError(null)
    setIsSaving(true)
    try {
      // Explicit whitelist — only these three fields ever leave this page,
      // matching UpdateOrganizationSettingsInput. There is no way to reach
      // id/slug/organization_id/created_by/created_at from this form.
      await updateSettings({
        name: values.name,
        supportEmail: values.supportEmail,
        brandColor: values.brandColor,
      })
      setSaveSuccess(true)
    } catch (error) {
      // Never show a false success — this only runs when updateSettings()
      // actually threw (network error, or RLS rejecting the write).
      setSaveError(error instanceof Error ? error.message : 'No se pudo guardar la configuración. Inténtalo de nuevo.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Configuración"
        description={
          canEdit
            ? 'Gestiona el perfil de tu espacio de trabajo.'
            : 'Estás viendo esta configuración en modo solo lectura. Tu rol no permite modificar la configuración de la organización.'
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Perfil de la organización</CardTitle>
          <CardDescription>Esta información aparece en tus formularios públicos y en el widget de chat.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit(handleSave)} noValidate>
          {/* A disabled <fieldset> natively disables every nested input
              without threading a `disabled` prop through each one
              individually — same pattern as ChatSettingsPage.tsx for
              viewer. `display: contents` keeps it invisible to the existing
              grid layout. RLS is still what actually blocks a member/
              viewer's write — this is UX only. */}
          <fieldset disabled={!canEdit} className="contents">
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label="Nombre del negocio *"
                error={errors.name?.message}
                {...register('name')}
              />
              {/* The slug is intentionally never editable from this form,
                  regardless of role — changing it could break existing
                  public /f/:formId and /c/:orgSlug links already shared.
                  readOnly (not part of `register`) keeps it out of the
                  submitted payload entirely, not just visually disabled. */}
              <Input
                label="URL del espacio de trabajo"
                value={organization ? `leadai.app/${organization.slug}` : ''}
                readOnly
                hint="No se puede cambiar por ahora para no romper enlaces públicos ya compartidos."
              />
              <Input
                label="Correo de soporte"
                type="email"
                placeholder="hola@tunegocio.com"
                error={errors.supportEmail?.message}
                {...register('supportEmail')}
              />
              <div className="flex items-start gap-2">
                <Input
                  label="Color de marca"
                  placeholder="#6366F1"
                  error={errors.brandColor?.message}
                  className="flex-1"
                  {...register('brandColor')}
                />
                <span
                  aria-hidden="true"
                  className="mt-7 size-10 shrink-0 rounded-lg border border-slate-700"
                  style={{
                    backgroundColor: HEX_COLOR_PATTERN.test(watchedBrandColor) ? watchedBrandColor : 'transparent',
                  }}
                />
              </div>
            </CardContent>

            {saveError && (
              <div className="mx-6 mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                <AlertCircle className="size-4 shrink-0" />
                {saveError}
              </div>
            )}

            {canEdit && (
              <CardFooter className="items-center justify-end gap-3">
                {saveSuccess && !isSaving && (
                  <p className="flex items-center gap-1.5 text-sm text-emerald-400">
                    <CheckCircle2 className="size-4" />
                    Configuración guardada.
                  </p>
                )}
                <Button type="submit" isLoading={isSaving} disabled={!isDirty}>
                  Guardar cambios
                </Button>
              </CardFooter>
            )}
          </fieldset>
        </form>
      </Card>
    </div>
  )
}
