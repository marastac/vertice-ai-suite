import { UserPlus } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { Card } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { mockTeamMembers, teamMemberRoleBadgeVariant, teamMemberRoleLabel } from '@/entities/team-member'

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function TeamPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Equipo"
        description="Gestiona quién tiene acceso a tu espacio de trabajo de Lead AI."
        actions={<Button leftIcon={<UserPlus className="size-4" />}>Invitar miembro</Button>}
      />

      <Card className="divide-y divide-slate-800/70">
        {mockTeamMembers.map((member) => (
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
    </div>
  )
}
