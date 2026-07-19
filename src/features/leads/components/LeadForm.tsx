import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { Select } from '@/shared/ui/Select'
import { Textarea } from '@/shared/ui/Textarea'
import type { TeamMember } from '@/entities/team-member'
import { LEAD_SOURCES, LEAD_STATUSES, leadFormSchema, leadSourceLabel, leadStatusLabel } from '@/entities/lead'
import type { LeadFormInput, LeadFormValues } from '@/entities/lead'

export interface LeadFormProps {
  mode: 'create' | 'edit'
  defaultValues?: Partial<LeadFormValues>
  teamMembers: TeamMember[]
  onSubmit: (values: LeadFormValues) => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  submitError?: string | null
}

export function LeadForm({
  mode,
  defaultValues,
  teamMembers,
  onSubmit,
  onCancel,
  isSubmitting,
  submitError,
}: LeadFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LeadFormInput, unknown, LeadFormValues>({
    resolver: zodResolver(leadFormSchema),
    defaultValues: {
      name: '',
      email: '',
      phone: '',
      company: '',
      position: '',
      source: 'manual',
      status: 'new',
      notes: '',
      ...defaultValues,
    },
  })

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input label="Nombre completo *" placeholder="Ana Torres" error={errors.name?.message} {...register('name')} />
        <Input
          label="Correo electrónico *"
          type="email"
          placeholder="ana@empresa.com"
          error={errors.email?.message}
          {...register('email')}
        />
        <Input label="Teléfono" placeholder="+34 600 000 000" error={errors.phone?.message} {...register('phone')} />
        <Input label="Empresa *" placeholder="Empresa S.L." error={errors.company?.message} {...register('company')} />
        <Input label="Cargo" placeholder="Directora de Marketing" error={errors.position?.message} {...register('position')} />
        <Select label="Fuente *" error={errors.source?.message} {...register('source')}>
          {LEAD_SOURCES.map((source) => (
            <option key={source} value={source}>
              {leadSourceLabel[source]}
            </option>
          ))}
        </Select>
        <Select label="Estado *" error={errors.status?.message} {...register('status')}>
          {LEAD_STATUSES.map((status) => (
            <option key={status} value={status}>
              {leadStatusLabel[status]}
            </option>
          ))}
        </Select>
        <Input
          label="Presupuesto estimado (USD)"
          type="number"
          min={0}
          placeholder="10000"
          error={errors.estimatedBudget?.message}
          {...register('estimatedBudget')}
        />
        {mode === 'edit' && (
          <>
            <Input
              label="Puntuación (0-100)"
              type="number"
              min={0}
              max={100}
              error={errors.score?.message}
              {...register('score')}
            />
            <Select label="Persona asignada" error={errors.assignedTo?.message} {...register('assignedTo')}>
              <option value="">Sin asignar</option>
              {teamMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          </>
        )}
        <Textarea
          label="Notas"
          placeholder="Contexto relevante sobre este lead…"
          error={errors.notes?.message}
          className="sm:col-span-2"
          {...register('notes')}
        />
      </div>

      {submitError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertCircle className="size-4 shrink-0" />
          {submitError}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancelar
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {mode === 'create' ? 'Crear lead' : 'Guardar cambios'}
        </Button>
      </div>
    </form>
  )
}
