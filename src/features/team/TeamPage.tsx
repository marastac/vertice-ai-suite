import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Link2, UserPlus } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { useAuth } from '@/entities/auth'
import { leadKeys } from '@/entities/lead'
import {
  teamMemberRoleBadgeVariant,
  teamMemberRoleLabel,
  useRemoveMemberMutation,
  useTeamMembersQuery,
} from '@/entities/team-member'
import type { TeamMember } from '@/entities/team-member'
import {
  canManageInvites,
  canManageMembers,
  formatInviteExpiresAt,
  getInviteUrl,
  inviteStatusBadgeVariant,
  inviteStatusLabel,
  organizationRoleLabel,
  translateMemberError,
  useInvitesQuery,
  useOrganization,
  useRevokeInviteMutation,
} from '@/entities/organization'
import { ChangeRoleModal } from './components/ChangeRoleModal'
import { InviteMemberModal } from './components/InviteMemberModal'
import { MemberActionsMenu } from './components/MemberActionsMenu'

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function TeamPage() {
  const { organization, role } = useOrganization()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  // See entities/organization/permissions.ts for what these mirror and why
  // they're shared with useInvitesQuery/the RPCs instead of computed
  // independently here — canManageInvites and canManageMembers happen to
  // have the same value today but are deliberately separate permissions.
  const canManage = canManageInvites(role)
  const canManageTeam = canManageMembers(role)

  const { data: teamMembers = [] } = useTeamMembersQuery()
  const { data: invites = [] } = useInvitesQuery()
  const revokeMutation = useRevokeInviteMutation()
  const removeMemberMutation = useRemoveMemberMutation()

  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null)
  const [inviteToRevoke, setInviteToRevoke] = useState<string | null>(null)
  const [memberToChangeRole, setMemberToChangeRole] = useState<TeamMember | null>(null)
  const [memberToRemove, setMemberToRemove] = useState<TeamMember | null>(null)

  async function handleCopyLink(inviteId: string, token: string) {
    await navigator.clipboard.writeText(getInviteUrl(token))
    setCopiedInviteId(inviteId)
    setTimeout(() => setCopiedInviteId((current) => (current === inviteId ? null : current)), 2000)
  }

  async function handleRemoveMember() {
    if (!memberToRemove) return
    await removeMemberMutation.mutateAsync(memberToRemove.id)
    // Removal can null out leads.assigned_to for whatever this person had —
    // entities/team-member's own mutation only invalidates its own query key
    // (see hooks.ts's comment on why it can't import entities/lead), so the
    // leads list is invalidated here instead, at the feature layer where both
    // entities are already in scope.
    queryClient.invalidateQueries({ queryKey: leadKeys.list(organization?.id) })
    setMemberToRemove(null)
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
          canManage ? (
            <Button leftIcon={<UserPlus className="size-4" />} onClick={() => setIsInviteModalOpen(true)}>
              Invitar miembro
            </Button>
          ) : undefined
        }
      />

      <Card className="divide-y divide-slate-800/70">
        {teamMembers.map((member) => {
          // Neither is-owner nor is-self is optional here — both are hard
          // rejections in update_member_role()/remove_organization_member()
          // and their RLS backstop (see supabase/schema.sql), so showing the
          // menu for either case would only ever produce a doomed request.
          const isOwner = member.role === 'owner'
          const isSelf = Boolean(user?.email) && member.email.toLowerCase() === user!.email!.toLowerCase()
          const canActOnMember = canManageTeam && !isOwner && !isSelf

          return (
            <div key={member.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-sm font-semibold text-white">
                  {initials(member.name)}
                </span>
                <div>
                  <p className="text-sm font-medium text-slate-100">
                    {member.name}
                    {isSelf && <span className="text-slate-500"> (tú)</span>}
                  </p>
                  <p className="text-xs text-slate-500">{member.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={teamMemberRoleBadgeVariant[member.role]}>{teamMemberRoleLabel[member.role]}</Badge>
                {canActOnMember && (
                  <MemberActionsMenu
                    memberName={member.name}
                    onChangeRole={() => setMemberToChangeRole(member)}
                    onRemove={() => setMemberToRemove(member)}
                  />
                )}
              </div>
            </div>
          )
        })}
      </Card>

      {canManage && invites.length > 0 && (
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

      {canManage && (
        <>
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
        </>
      )}

      {canManageTeam && (
        <>
          <ChangeRoleModal member={memberToChangeRole} onClose={() => setMemberToChangeRole(null)} />

          <ConfirmDialog
            isOpen={memberToRemove !== null}
            title="Eliminar del equipo"
            description={
              memberToRemove
                ? `${memberToRemove.name} perderá acceso a esta organización. Sus leads asignados quedarán sin asignar (no se eliminarán). Su cuenta y su acceso a otras organizaciones no se ven afectados.`
                : undefined
            }
            confirmLabel="Eliminar"
            isConfirming={removeMemberMutation.isPending}
            error={
              removeMemberMutation.isError
                ? translateMemberError(
                    removeMemberMutation.error instanceof Error ? removeMemberMutation.error.message : '',
                  )
                : undefined
            }
            onConfirm={handleRemoveMember}
            onCancel={() => {
              removeMemberMutation.reset()
              setMemberToRemove(null)
            }}
          />
        </>
      )}
    </div>
  )
}
