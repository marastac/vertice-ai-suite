import { useEffect, useRef, useState } from 'react'
import { MoreVertical, ShieldCheck, UserMinus } from 'lucide-react'
import { Button } from '@/shared/ui/Button'

interface MemberActionsMenuProps {
  memberName: string
  onChangeRole: () => void
  onRemove: () => void
}

/**
 * Only ever rendered by TeamPage.tsx when canManageMembers(role) is true AND
 * the row is neither the owner nor the signed-in user themselves — those
 * exclusions happen at the call site so this component stays a dumb menu,
 * not a place that re-implements permission logic. The real protection is
 * server-side either way (update_member_role()/remove_organization_member()
 * and their backing RLS both reject those same cases) — this just avoids
 * ever showing a control that would fail.
 */
export function MemberActionsMenu({ memberName, onChangeRole, onRemove }: MemberActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  return (
    <div ref={menuRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Acciones para ${memberName}`}
        onClick={() => setIsOpen((open) => !open)}
      >
        <MoreVertical className="size-4" />
      </Button>

      {isOpen && (
        <div className="absolute right-0 top-full z-40 mt-2 w-48 rounded-lg border border-slate-800 bg-vertice-surface p-1 shadow-lg shadow-black/40">
          <button
            type="button"
            onClick={() => {
              setIsOpen(false)
              onChangeRole()
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800/60 hover:text-white"
          >
            <ShieldCheck className="size-4" /> Cambiar rol
          </button>
          <button
            type="button"
            onClick={() => {
              setIsOpen(false)
              onRemove()
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            <UserMinus className="size-4" /> Eliminar del equipo
          </button>
        </div>
      )}
    </div>
  )
}
