import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useOrganization } from '@/entities/organization'

interface OrganizationSwitcherProps {
  /** MobileNav passes onClose here so picking an org also closes the drawer. */
  onSwitch?: () => void
}

export function OrganizationSwitcher({ onSwitch }: OrganizationSwitcherProps) {
  const { organization, organizations, switchOrganization } = useOrganization()
  const navigate = useNavigate()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isMenuOpen) return
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setIsMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isMenuOpen])

  // Common case today: a single organization — same plain text as before, no dropdown.
  if (organizations.length <= 1) {
    return <p className="truncate text-xs text-slate-500">Espacio de trabajo de {organization?.name ?? '…'}</p>
  }

  function handleSwitch(organizationId: string) {
    switchOrganization(organizationId)
    setIsMenuOpen(false)
    navigate('/dashboard')
    onSwitch?.()
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setIsMenuOpen((open) => !open)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-800/60"
      >
        <span className="truncate text-xs text-slate-400">Espacio de trabajo de {organization?.name ?? '…'}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-slate-500" />
      </button>

      {isMenuOpen && (
        <div className="absolute inset-x-0 bottom-full z-40 mb-2 rounded-lg border border-slate-800 bg-vertice-surface p-1 shadow-lg shadow-black/40">
          {organizations.map((membership) => (
            <button
              key={membership.organization.id}
              type="button"
              onClick={() => handleSwitch(membership.organization.id)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800/60 hover:text-white"
            >
              <span className="truncate">{membership.organization.name}</span>
              {membership.organization.id === organization?.id && (
                <Check className="size-4 shrink-0 text-blue-400" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
