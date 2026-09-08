import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Select } from '@/shared/ui/Select'
import { Modal } from '@/shared/ui/Modal'
import { organizationRoleLabel, translateMemberError } from '@/entities/organization'
import { useUpdateMemberRoleMutation } from '@/entities/team-member'
import type { AssignableTeamMemberRole, TeamMember } from '@/entities/team-member'

// 'owner' deliberately excluded — update_member_role() never accepts it as a
// new role (no ownership-transfer feature), so it's not offered here either.
const ASSIGNABLE_ROLES: AssignableTeamMemberRole[] = ['admin', 'member', 'viewer']

interface ChangeRoleModalProps {
  /** null closes the modal — same "controlled by the value, not a separate isOpen flag" shape as passing the row itself avoids a stale reference once the list refetches. */
  member: TeamMember | null
  onClose: () => void
}

export function ChangeRoleModal({ member, onClose }: ChangeRoleModalProps) {
  const mutation = useUpdateMemberRoleMutation()
  const [selectedRole, setSelectedRole] = useState<AssignableTeamMemberRole>('member')

  // Reset the picker to the member's current role each time a new member is
  // targeted (member.role is never 'owner' here — TeamPage never opens this
  // modal for the owner's row — but the fallback keeps the type honest).
  useEffect(() => {
    if (member) setSelectedRole(member.role === 'owner' ? 'member' : member.role)
  }, [member])

  function handleClose() {
    mutation.reset()
    onClose()
  }

  async function handleSubmit() {
    if (!member) return
    await mutation.mutateAsync({ teamMemberId: member.id, newRole: selectedRole })
    handleClose()
  }

  return (
    <Modal
      isOpen={member !== null}
      onClose={handleClose}
      title="Cambiar rol"
      description={member ? `Elige el nuevo rol de ${member.name} en esta organización.` : undefined}
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Rol"
          value={selectedRole}
          onChange={(event) => setSelectedRole(event.target.value as AssignableTeamMemberRole)}
        >
          {ASSIGNABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {organizationRoleLabel[role]}
            </option>
          ))}
        </Select>

        {mutation.isError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4 shrink-0" />
            {translateMemberError(mutation.error instanceof Error ? mutation.error.message : '')}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={handleClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            isLoading={mutation.isPending}
            disabled={member ? selectedRole === member.role : true}
          >
            Guardar
          </Button>
        </div>
      </div>
    </Modal>
  )
}
