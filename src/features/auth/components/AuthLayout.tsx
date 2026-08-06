import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/ui/Card'

interface AuthLayoutProps {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}

export function AuthLayout({ title, description, children, footer }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-vertice-bg px-4 py-10 text-slate-100">
      <div className="flex w-full max-w-md flex-col items-center gap-2 pb-6">
        <span className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
          <Sparkles className="size-5 text-white" />
        </span>
        <span className="text-base font-semibold text-white">Lead AI</span>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
        {footer && <CardFooter className="justify-center text-sm">{footer}</CardFooter>}
      </Card>
    </div>
  )
}
