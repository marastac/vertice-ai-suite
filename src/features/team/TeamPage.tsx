import { useState } from 'react'
import { Check, Link2, UserPlus } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { teamMemberRoleBadgeVariant, teamMemberRoleLabel, useTeamMembersQuery } from '@/entities/team-member'
import {
  formatInviteExpiresAt,
  getInviteUrl,
  inviteStatusBadgeVariant,
  inviteStatusLabel,
  organizationRoleLabel,
  useInvitesQuery,
  useRevokeInviteMutation,
} from '@/entities/organization'
import { InviteMemberModal } from './components/InviteMemberModal'

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function TeamPage() {
  const { data: teamMembers = [] } = useTeamMembersQuery()
  const { data: invites = [] } = useInvitesQuery()
  const revokeMutation = useRevokeInviteMutation()

  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null)
  const [inviteToRevoke, setInviteToRevoke] = useState<string | null>(null)

  async function handleCopyLink(inviteId: string, token: string) {
    await navigator.clipboard.writeText(getInviteUrl(token))
    setCopiedInviteId(inviteId)
    setTimeout(() => setCopiedInviteId((current) => (current === inviteId ? null : current)), 2000)
  }

  async function handleRevoke() {
    if (!inviteToRevoke) return
    await revokeMutation.mutateAsync(inviteToRevoke)
    setInviteToRevoke(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Equipo"
        description="Gestiona quién tiene acceso a tu espacio de trabajo de Lead AI."
        actions={
          <Button leftIcon={<UserPlus className="size-4" />} onClick={() => setIsInviteModalOpen(true)}>
            Invitar miembro
          </Button>
        }
      />

      <Card className="divide-y divide-slate-800/70">
        {teamMembers.map((member) => (
          <div key={member.id} className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-sm font-semibold text-white">
                {initials(member.name)}
              </span>
              <div>
                <p className="text-sm font-medium text-slate-100">{member.name}</p>
                <p className="text-xs text-slate-500">{member.email}</p>
              </div>
            </div>
            <Badge variant={teamMemberRoleBadgeVariant[member.role]}>{teamMemberRoleLabel[member.role]}</Badge>
          </div>
        ))}
      </Card>

      {invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Invitaciones pendientes</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-slate-800/70 p-0">
            {invites.map((invite) => (
              <div key={invite.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <p className="text-sm font-medium text-slate-100">{invite.email}</p>
                  <p className="text-xs text-slate-500">
                    {organizationRoleLabel[invite.role]} · Expira el {formatInviteExpiresAt(invite.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={inviteStatusBadgeVariant[invite.status]}>{inviteStatusLabel[invite.status]}</Badge>
                  {invite.status === 'pending' && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Copiar enlace de invitación"
                        onClick={() => handleCopyLink(invite.id, invite.token)}
                      >
                        {copiedInviteId === invite.id ? (
                          <Check className="size-4 text-emerald-400" />
                        ) : (
                          <Link2 className="size-4" />
                        )}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setInviteToRevoke(invite.id)}>
                        Revocar
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <InviteMemberModal isOpen={isInviteModalOpen} onClose={() => setIsInviteModalOpen(false)} />

      <ConfirmDialog
        isOpen={inviteToRevoke !== null}
        title="Revocar invitación"
        description="La persona invitada ya no podrá usar este enlace para unirse."
        confirmLabel="Revocar"
        isConfirming={revokeMutation.isPending}
        onConfirm={handleRevoke}
        onCancel={() => setInviteToRevoke(null)}
      />
    </div>
  )
}
