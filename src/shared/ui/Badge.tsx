import type { HTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'

export type BadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'gradient'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

const variantClasses: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-800 text-slate-300 ring-1 ring-inset ring-slate-700',
  info: 'bg-blue-500/10 text-blue-300 ring-1 ring-inset ring-blue-500/30',
  success: 'bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/30',
  warning: 'bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/30',
  danger: 'bg-red-500/10 text-red-300 ring-1 ring-inset ring-red-500/30',
  gradient: 'bg-gradient-to-r from-blue-500/20 to-purple-600/20 text-blue-200 ring-1 ring-inset ring-blue-500/30',
}

export function Badge({ className, variant = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  )
}
