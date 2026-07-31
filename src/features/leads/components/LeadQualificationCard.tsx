import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Badge } from '@/shared/ui/Badge'
import { chatQualificationStatusBadgeVariant, chatQualificationStatusLabel, useChatSessionQuery } from '@/entities/chat'

export interface LeadQualificationCardProps {
  chatSessionId: string
}

export function LeadQualificationCard({ chatSessionId }: LeadQualificationCardProps) {
  const { data: session } = useChatSessionQuery(chatSessionId)
  const qualification = session?.qualification

  if (!qualification) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Resumen de calificación por IA</CardTitle>
          <Badge variant={chatQualificationStatusBadgeVariant[qualification.status]}>
            {chatQualificationStatusLabel[qualification.status]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-slate-300">{qualification.summary}</p>

        <div>
          <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">Motivos</p>
          {qualification.reasons.length > 0 ? (
            <ul className="flex flex-col gap-1 text-slate-300">
              {qualification.reasons.map((reason, index) => (
                <li key={index} className="flex gap-2">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-slate-500" />
                  {reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-500">Sin motivos registrados.</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Recopilado</p>
            {qualification.collectedFields.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {qualification.collectedFields.map((field) => (
                  <Badge key={field} variant="success">
                    {field}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-slate-500">Ninguna todavía.</p>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Falta</p>
            {qualification.missingFields.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {qualification.missingFields.map((field) => (
                  <Badge key={field} variant="warning">
                    {field}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-slate-500">Ninguna.</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
