import type { LucideIcon } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

interface BusinessTypeCardProps {
  icon: LucideIcon
  label: string
  description: string
  selected: boolean
  onSelect: () => void
}

export function BusinessTypeCard({ icon: Icon, label, description, selected, onSelect }: BusinessTypeCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex flex-col items-start gap-3 rounded-xl border p-5 text-left transition-colors',
        selected
          ? 'border-blue-500 bg-blue-500/10 ring-1 ring-inset ring-blue-500/40'
          : 'border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900',
      )}
    >
      <span
        className={cn(
          'flex size-10 items-center justify-center rounded-lg',
          selected ? 'bg-gradient-to-br from-blue-500 to-purple-600 text-white' : 'bg-slate-800 text-slate-300',
        )}
      >
        <Icon className="size-5" />
      </span>
      <div>
        <p className="text-sm font-semibold text-white">{label}</p>
        <p className="mt-1 text-xs text-slate-400">{description}</p>
      </div>
    </button>
  )
}
