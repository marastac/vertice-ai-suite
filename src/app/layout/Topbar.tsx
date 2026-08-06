import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, LogOut, Menu } from 'lucide-react'
import { useAuth } from '@/entities/auth'

interface TopbarProps {
  onOpenMobileNav: () => void
}

function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase())
  return initials.join('') || '?'
}

export function Topbar({ onOpenMobileNav }: TopbarProps) {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isMenuOpen) return
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isMenuOpen])

  const displayName = (user?.user_metadata?.full_name as string | undefined) || user?.email || 'Cuenta'

  const handleSignOut = async () => {
    setIsMenuOpen(false)
    await signOut()
    navigate('/login', { replace: true })
  }

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

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setIsMenuOpen((open) => !open)}
            className="flex items-center gap-2 rounded-lg py-1.5 pr-3 pl-1.5 hover:bg-slate-800/60"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-xs font-semibold text-white">
              {initialsFor(displayName)}
            </span>
            <span className="hidden max-w-[10rem] truncate text-sm font-medium text-slate-200 sm:inline">
              {displayName}
            </span>
          </button>

          {isMenuOpen && (
            <div className="absolute right-0 top-full z-40 mt-2 w-56 rounded-lg border border-slate-800 bg-vertice-surface p-1 shadow-lg shadow-black/40">
              <div className="px-3 py-2">
                <p className="truncate text-sm font-medium text-white">{displayName}</p>
                {user?.email && <p className="truncate text-xs text-slate-500">{user.email}</p>}
              </div>
              <div className="my-1 h-px bg-slate-800" />
              <button
                type="button"
                onClick={handleSignOut}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60 hover:text-white"
              >
                <LogOut className="size-4" />
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
