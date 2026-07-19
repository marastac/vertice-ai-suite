import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Button } from '@/shared/ui/Button'

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={<Compass className="size-5" />}
        title="Página no encontrada"
        description="La página que buscas no existe o ha sido movida."
        action={
          <Link to="/dashboard">
            <Button>Volver al panel</Button>
          </Link>
        }
      />
    </div>
  )
}
