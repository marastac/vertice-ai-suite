import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
}

export function Switch({ checked, onCheckedChange, label, className, disabled, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn('inline-flex items-center gap-2 text-sm text-slate-200 disabled:cursor-not-allowed', className)}
      {...props}
    >
      <span
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-gradient-to-r from-blue-500 to-purple-600' : 'bg-slate-700',
          disabled && 'opacity-50',
        )}
      >
        <span
          className={cn(
            'inline-block size-4 translate-x-1 transform rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-6',
          )}
        />
      </span>
      {label}
    </button>
  )
}
