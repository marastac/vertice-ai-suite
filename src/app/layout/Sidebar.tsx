import { NavLink } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { useOrganization } from '@/entities/organization'
import { cn } from '@/shared/lib/cn'
import { navItems } from './nav-config'

export function Sidebar() {
  const { organization } = useOrganization()

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800/80 bg-vertice-surface lg:flex">
      <div className="flex h-16 items-center gap-2 px-6">
        <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
          <Sparkles className="size-4 text-white" />
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-white">Lead AI</p>
          <p className="text-[11px] text-slate-500">Califica tus clientes con IA</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
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

      <div className="border-t border-slate-800/80 px-4 py-4">
        <p className="truncate text-xs text-slate-500">
          Espacio de trabajo de {organization?.name ?? '…'}
        </p>
      </div>
    </aside>
  )
}
