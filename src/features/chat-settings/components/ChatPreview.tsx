import { Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { chatToneLabel } from '@/entities/chat'
import type { ChatTone } from '@/entities/chat'
import { useOrganization } from '@/entities/organization'

export interface ChatPreviewProps {
  assistantName: string
  welcomeMessage: string
  tone: ChatTone
  isActive: boolean
}

export function ChatPreview({ assistantName, welcomeMessage, tone, isActive }: ChatPreviewProps) {
  const { organization } = useOrganization()

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Vista previa</CardTitle>
          <Badge variant={isActive ? 'success' : 'neutral'}>{isActive ? 'Activo' : 'Inactivo'}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
            <Sparkles className="size-4 text-white" />
          </span>
          <div>
            <p className="text-sm font-semibold text-white">{assistantName || 'Asistente'}</p>
            <p className="text-xs text-slate-500">Tono: {chatToneLabel[tone]}</p>
          </div>
        </div>

        <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-slate-800 bg-slate-800/60 px-4 py-3 text-sm text-slate-100">
          {welcomeMessage || 'Escribe un mensaje de bienvenida para verlo aquí.'}
        </div>

        <p className="text-xs text-slate-500">
          Así es como los visitantes verán el inicio de la conversación en{' '}
          <code>/c/{organization?.slug ?? '…'}</code>.
        </p>
      </CardContent>
    </Card>
  )
}
