import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { Card } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import type { Lead } from '@/entities/lead'
import { leadStatusBadgeVariant, leadStatusLabel } from '@/entities/lead'
import type { FormSubmission } from '@/entities/form'
import { formatFormDateTime } from '@/entities/form'

export interface FormSubmissionTableProps {
  submissions: FormSubmission[]
  leads: Lead[]
}

export function FormSubmissionTable({ submissions, leads }: FormSubmissionTableProps) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-xs tracking-wide text-slate-500 uppercase">
            <th className="px-5 py-3 font-medium">Enviado</th>
            <th className="px-5 py-3 font-medium">Contacto</th>
            <th className="px-5 py-3 font-medium">Puntuación</th>
            <th className="px-5 py-3 font-medium">Estado</th>
            <th className="px-5 py-3 font-medium">Lead</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {submissions.map((submission) => {
            const lead = leads.find((item) => item.id === submission.leadId)
            return (
              <tr key={submission.id} className="transition-colors hover:bg-slate-800/40">
                <td className="px-5 py-4 text-slate-400">{formatFormDateTime(submission.submittedAt)}</td>
                <td className="px-5 py-4">
                  {lead ? (
                    <>
                      <p className="font-medium text-slate-100">{lead.name}</p>
                      <p className="text-xs text-slate-500">{lead.email}</p>
                    </>
                  ) : (
                    <span className="text-slate-500">Sin datos de contacto</span>
                  )}
                </td>
                <td className="px-5 py-4 font-semibold text-slate-200">{submission.score}</td>
                <td className="px-5 py-4">
                  {lead && <Badge variant={leadStatusBadgeVariant[lead.status]}>{leadStatusLabel[lead.status]}</Badge>}
                </td>
                <td className="px-5 py-4">
                  {lead && (
                    <Link
                      to={`/leads/${lead.id}`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-blue-400 hover:text-blue-300"
                    >
                      Ver lead
                      <ArrowUpRight className="size-3.5" />
                    </Link>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}
