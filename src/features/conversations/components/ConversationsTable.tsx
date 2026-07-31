import { Link } from 'react-router-dom'
import { Card } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import {
  chatQualificationStatusBadgeVariant,
  chatQualificationStatusLabel,
  formatChatDateTime,
} from '@/entities/chat'
import type { ChatSession } from '@/entities/chat'

interface ConversationsTableProps {
  sessions: ChatSession[]
}

function ContactCell({ session }: { session: ChatSession }) {
  return (
    <>
      <p className="font-medium text-slate-100">{session.qualification?.contactName ?? 'Visitante'}</p>
      <p className="text-xs text-slate-500">{session.qualification?.email ?? 'Sin correo todavía'}</p>
    </>
  )
}

function StatusBadge({ session }: { session: ChatSession }) {
  if (!session.qualification) {
    return <Badge variant="neutral">En curso</Badge>
  }
  return (
    <Badge variant={chatQualificationStatusBadgeVariant[session.qualification.status]}>
      {chatQualificationStatusLabel[session.qualification.status]}
    </Badge>
  )
}

export function ConversationsTable({ sessions }: ConversationsTableProps) {
  return (
    <>
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs tracking-wide text-slate-500 uppercase">
              <th className="px-5 py-3 font-medium">Fecha</th>
              <th className="px-5 py-3 font-medium">Contacto</th>
              <th className="px-5 py-3 font-medium">Estado</th>
              <th className="px-5 py-3 font-medium">Puntuación</th>
              <th className="px-5 py-3 font-medium">Mensajes</th>
              <th className="px-5 py-3 font-medium">Completa</th>
              <th className="px-5 py-3 font-medium">Lead</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {sessions.map((session) => (
              <tr key={session.id} className="transition-colors hover:bg-slate-800/40">
                <td className="px-5 py-4 text-slate-400">{formatChatDateTime(session.createdAt)}</td>
                <td className="px-5 py-4">
                  <ContactCell session={session} />
                </td>
                <td className="px-5 py-4">
                  <StatusBadge session={session} />
                </td>
                <td className="px-5 py-4 font-semibold text-slate-200">{session.qualification?.score ?? '—'}</td>
                <td className="px-5 py-4 text-slate-400">{session.messages.length}</td>
                <td className="px-5 py-4 text-slate-400">
                  {session.qualification?.conversationComplete ? 'Sí' : 'No'}
                </td>
                <td className="px-5 py-4">
                  {session.leadId ? (
                    <Link to={`/leads/${session.leadId}`} className="font-medium text-blue-400 hover:text-blue-300">
                      Ver lead
                    </Link>
                  ) : (
                    <span className="text-slate-600">Sin lead</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
        {sessions.map((session) => (
          <Card key={session.id} className="flex h-full flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <ContactCell session={session} />
              </div>
              <StatusBadge session={session} />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{session.messages.length} mensajes</span>
              <span className="font-semibold text-slate-200">{session.qualification?.score ?? '—'} pts</span>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{formatChatDateTime(session.createdAt)}</span>
              {session.leadId ? (
                <Link to={`/leads/${session.leadId}`} className="font-medium text-blue-400 hover:text-blue-300">
                  Ver lead
                </Link>
              ) : (
                <span>Sin lead</span>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  )
}
