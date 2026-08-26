import { AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/shared/ui/Card'

interface InviteStatusMessageProps {
  title: string
  description: string
}

export function InviteStatusMessage({ title, description }: InviteStatusMessageProps) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-red-500/10 text-red-300">
          <AlertCircle className="size-6" />
        </span>
        <h1 className="text-lg font-semibold text-white">{title}</h1>
        <p className="max-w-sm text-sm text-slate-400">{description}</p>
      </CardContent>
    </Card>
  )
}
