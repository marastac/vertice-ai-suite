import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Input } from '@/shared/ui/Input'
import { Modal } from '@/shared/ui/Modal'
import { Select } from '@/shared/ui/Select'
import { inviteMemberSchema, organizationRoleLabel, useCreateInviteMutation } from '@/entities/organization'
import type { InviteMemberValues } from '@/entities/organization'

interface InviteMemberModalProps {
  isOpen: boolean
  onClose: () => void
}

const INVITABLE_ROLES = ['admin', 'member', 'viewer'] as const

export function InviteMemberModal({ isOpen, onClose }: InviteMemberModalProps) {
  const createInviteMutation = useCreateInviteMutation()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteMemberValues>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: '', role: 'member' },
  })

  function handleClose() {
    reset()
    createInviteMutation.reset()
    onClose()
  }

  const onSubmit = async (values: InviteMemberValues) => {
    await createInviteMutation.mutateAsync(values)
    handleClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Invitar miembro"
      description="Genera una invitación para que alguien se una a tu espacio de trabajo."
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <Input
          label="Correo electrónico"
          type="email"
          autoComplete="email"
          placeholder="persona@empresa.com"
          error={errors.email?.message}
          {...register('email')}
        />
        <Select label="Rol" error={errors.role?.message} {...register('role')}>
          {INVITABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {organizationRoleLabel[role]}
            </option>
          ))}
        </Select>

        {createInviteMutation.isError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            No se pudo crear la invitación. Inténtalo de nuevo.
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancelar
          </Button>
          <Button type="submit" isLoading={createInviteMutation.isPending}>
            Enviar invitación
          </Button>
        </div>
      </form>
    </Modal>
  )
}
