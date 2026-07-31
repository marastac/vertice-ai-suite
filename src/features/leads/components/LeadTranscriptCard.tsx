import { MessagesSquare } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { EmptyState } from '@/shared/ui/EmptyState'
import { cn } from '@/shared/lib/cn'
import { formatChatDateTime, useChatSessionQuery } from '@/entities/chat'

export interface LeadTranscriptCardProps {
  chatSessionId: string | undefined
}

export function LeadTranscriptCard({ chatSessionId }: LeadTranscriptCardProps) {
  const { data: session, isLoading } = useChatSessionQuery(chatSessionId)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversación</CardTitle>
      </CardHeader>
      <CardContent>
        {!chatSessionId && (
          <EmptyState
            icon={<MessagesSquare className="size-5" />}
            title="Sin conversación todavía"
            description="Cuando la calificación por chat con IA esté activa, aquí aparecerá la transcripción completa."
          />
        )}

        {chatSessionId && isLoading && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-lg bg-slate-800/60" />
            ))}
          </div>
        )}

        {chatSessionId && !isLoading && !session && (
          <p className="text-sm text-slate-400">
            No se encontró la transcripción de esta conversación en este navegador.
          </p>
        )}

        {session && (
          <div className="flex max-h-[480px] flex-col gap-3 overflow-y-auto pr-1">
            {session.messages.map((message) => (
              <div
                key={message.id}
                className={cn('flex flex-col gap-1', message.role === 'user' ? 'items-end' : 'items-start')}
              >
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm',
                    message.role === 'user'
                      ? 'rounded-tr-sm bg-gradient-to-r from-blue-500 to-purple-600 text-white'
                      : 'rounded-tl-sm border border-slate-800 bg-slate-800/60 text-slate-100',
                  )}
                >
                  {message.content}
                </div>
                <span className="px-1 text-[11px] text-slate-500">{formatChatDateTime(message.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
