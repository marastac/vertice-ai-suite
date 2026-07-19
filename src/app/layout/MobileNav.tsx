import { NavLink } from 'react-router-dom'
import { Sparkles, X } from 'lucide-react'
import { cn } from '@/shared/lib/cn'
import { navItems } from './nav-config'

interface MobileNavProps {
  isOpen: boolean
  onClose: () => void
}

export function MobileNav({ isOpen, onClose }: MobileNavProps) {
  return (
    <div
      className={cn('fixed inset-0 z-40 lg:hidden', isOpen ? 'pointer-events-auto' : 'pointer-events-none')}
      aria-hidden={!isOpen}
    >
      <button
        type="button"
        aria-label="Cerrar navegación"
        tabIndex={isOpen ? 0 : -1}
        className={cn(
          'absolute inset-0 bg-black/60 transition-opacity duration-200',
          isOpen ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          'absolute inset-y-0 left-0 flex w-72 max-w-[80%] flex-col bg-vertice-surface shadow-xl transition-transform duration-200',
          isOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
              <Sparkles className="size-4 text-white" />
            </span>
            <span className="text-sm font-semibold text-white">Lead AI</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800/60 hover:text-white"
            aria-label="Cerrar navegación"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-100',
                  isActive &&
                    'bg-gradient-to-r from-blue-500/15 to-purple-600/15 text-white ring-1 ring-inset ring-blue-500/20',
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}
