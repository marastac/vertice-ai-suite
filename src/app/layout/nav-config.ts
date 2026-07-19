import { ClipboardList, LayoutDashboard, MessageSquareText, Plug, Settings, Users, UsersRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  label: string
  to: string
  icon: LucideIcon
}

export const navItems: NavItem[] = [
  { label: 'Panel', to: '/dashboard', icon: LayoutDashboard },
  { label: 'Leads', to: '/leads', icon: Users },
  { label: 'Formularios', to: '/forms', icon: ClipboardList },
  { label: 'Configuración del chat', to: '/chat-settings', icon: MessageSquareText },
  { label: 'Integraciones', to: '/integrations', icon: Plug },
  { label: 'Equipo', to: '/team', icon: UsersRound },
  { label: 'Configuración', to: '/settings', icon: Settings },
]
