import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-950/40 hover:from-blue-400 hover:to-purple-500 focus-visible:outline-blue-400',
  secondary:
    'border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700 focus-visible:outline-slate-400',
  outline:
    'border border-slate-700 text-slate-200 hover:bg-slate-800/60 focus-visible:outline-slate-400',
  ghost: 'text-slate-300 hover:bg-slate-800/60 hover:text-white focus-visible:outline-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-500 focus-visible:outline-red-400',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = 'primary', size = 'md', isLoading, leftIcon, rightIcon, disabled, children, ...props },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(
          'inline-flex items-center justify-center rounded-lg font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...props}
      >
        {isLoading ? <Loader2 className="size-4 animate-spin" /> : leftIcon}
        {children}
        {!isLoading && rightIcon}
      </button>
    )
  },
)
Button.displayName = 'Button'
