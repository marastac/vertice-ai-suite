import { ShieldAlert } from 'lucide-react'

export function SupabaseNotConfiguredNotice() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-300">
      <ShieldAlert className="size-4 shrink-0" />
      <span>
        Supabase no está configurado. Añade <code className="text-amber-200">VITE_SUPABASE_URL</code> y{' '}
        <code className="text-amber-200">VITE_SUPABASE_ANON_KEY</code> en tu archivo <code className="text-amber-200">.env</code> para
        activar la autenticación.
      </span>
    </div>
  )
}
