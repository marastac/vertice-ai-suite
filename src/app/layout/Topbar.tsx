import { Bell, Menu } from 'lucide-react'

interface TopbarProps {
  onOpenMobileNav: () => void
}

export function Topbar({ onOpenMobileNav }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-800/80 bg-vertice-surface/80 px-4 backdrop-blur sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenMobileNav}
          className="flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800/60 hover:text-white lg:hidden"
          aria-label="Abrir navegación"
        >
          <Menu className="size-5" />
        </button>
        <div className="flex items-center gap-2 lg:hidden">
          <span className="flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-purple-600 text-xs font-bold text-white">
            L
          </span>
          <span className="text-sm font-semibold text-white">Lead AI</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800/60 hover:text-white"
          aria-label="Notificaciones"
        >
          <Bell className="size-4" />
        </button>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg py-1.5 pr-3 pl-1.5 hover:bg-slate-800/60"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-xs font-semibold text-white">
            VA
          </span>
          <span className="hidden text-sm font-medium text-slate-200 sm:inline">Vertice Agency</span>
        </button>
      </div>
    </header>
  )
}
