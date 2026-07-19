import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-6 py-16 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500/20 to-purple-600/20 text-blue-300">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-slate-100">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-slate-400">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
