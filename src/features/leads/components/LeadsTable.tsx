import { Link } from 'react-router-dom'
import { Card } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import type { Lead } from '@/entities/lead'
import { formatLeadDate, leadSourceLabel, leadStatusBadgeVariant, leadStatusLabel } from '@/entities/lead'
import type { TeamMember } from '@/entities/team-member'

interface LeadsTableProps {
  leads: Lead[]
  teamMembers: TeamMember[]
}

function assignedName(teamMembers: TeamMember[], id: string | undefined) {
  if (!id) return 'Sin asignar'
  return teamMembers.find((member) => member.id === id)?.name ?? 'Sin asignar'
}

export function LeadsTable({ leads, teamMembers }: LeadsTableProps) {
  return (
    <>
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs tracking-wide text-slate-500 uppercase">
              <th className="px-5 py-3 font-medium">Lead</th>
              <th className="px-5 py-3 font-medium">Fuente</th>
              <th className="px-5 py-3 font-medium">Estado</th>
              <th className="px-5 py-3 font-medium">Puntuación</th>
              <th className="px-5 py-3 font-medium">Asignado a</th>
              <th className="px-5 py-3 font-medium">Creado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {leads.map((lead) => (
              <tr key={lead.id} className="transition-colors hover:bg-slate-800/40">
                <td className="px-5 py-4">
                  <Link to={`/leads/${lead.id}`} className="block">
                    <p className="font-medium text-slate-100">{lead.name}</p>
                    <p className="text-xs text-slate-500">{lead.company}</p>
                  </Link>
                </td>
                <td className="px-5 py-4 text-slate-300">{leadSourceLabel[lead.source]}</td>
                <td className="px-5 py-4">
                  <Badge variant={leadStatusBadgeVariant[lead.status]}>{leadStatusLabel[lead.status]}</Badge>
                </td>
                <td className="px-5 py-4 font-semibold text-slate-200">{lead.score}</td>
                <td className="px-5 py-4 text-slate-400">{assignedName(teamMembers, lead.assignedTo)}</td>
                <td className="px-5 py-4 text-slate-400">{formatLeadDate(lead.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
        {leads.map((lead) => (
          <Link key={lead.id} to={`/leads/${lead.id}`}>
            <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:bg-slate-800/40">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-100">{lead.name}</p>
                  <p className="truncate text-xs text-slate-500">{lead.company}</p>
                </div>
                <Badge variant={leadStatusBadgeVariant[lead.status]}>{leadStatusLabel[lead.status]}</Badge>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{leadSourceLabel[lead.source]}</span>
                <span className="font-semibold text-slate-200">{lead.score} pts</span>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{assignedName(teamMembers, lead.assignedTo)}</span>
                <span>{formatLeadDate(lead.createdAt)}</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </>
  )
}
