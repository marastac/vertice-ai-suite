import { forwardRef } from 'react'
import type { ReactNode, SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  children: ReactNode
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, hint, id, name, children, ...props }, ref) => {
    const selectId = id ?? name

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={selectId} className="text-sm font-medium text-slate-200">
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            name={name}
            className={cn(
              'h-10 w-full appearance-none rounded-lg border border-slate-700 bg-slate-900/60 px-3 pr-9 text-sm text-slate-100 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
              error && 'border-red-500 focus:border-red-500 focus:ring-red-500',
              className,
            )}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="pointer-events-none absolute inset-y-0 right-3 my-auto size-4 text-slate-500" />
        </div>
        {error ? (
          <p className="text-xs text-red-400">{error}</p>
        ) : hint ? (
          <p className="text-xs text-slate-500">{hint}</p>
        ) : null}
      </div>
    )
  },
)
Select.displayName = 'Select'
