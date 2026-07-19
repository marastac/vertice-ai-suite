import { MessageSquareText } from 'lucide-react'
import { PageHeader } from '@/shared/ui/PageHeader'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Badge } from '@/shared/ui/Badge'

export function ChatSettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Configuración del chat"
        description="Configura cómo el asistente de Lead AI califica a los leads en conversación."
        actions={<Badge variant="gradient">Próximamente</Badge>}
      />
      <EmptyState
        icon={<MessageSquareText className="size-5" />}
        title="El chat con IA aún no está activo"
        description="Aquí podrás configurar la personalidad, el tono y los criterios de calificación en cuanto se active el chat con IA."
      />
    </div>
  )
}
