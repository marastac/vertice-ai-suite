import { PageHeader } from '@/shared/ui/PageHeader'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/ui/Card'
import { Input } from '@/shared/ui/Input'
import { Button } from '@/shared/ui/Button'
import { useOrganization } from '@/entities/organization'

export function SettingsPage() {
  const { organization } = useOrganization()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Configuración" description="Gestiona el perfil de tu espacio de trabajo." />

      <Card>
        <CardHeader>
          <CardTitle>Perfil de la organización</CardTitle>
          <CardDescription>Esta información aparece en tus formularios públicos y en el widget de chat.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="Nombre del negocio" defaultValue={organization?.name ?? ''} />
          <Input label="URL del espacio de trabajo" defaultValue={organization ? `leadai.app/${organization.slug}` : ''} />
          <Input label="Correo de soporte" type="email" placeholder="hola@tunegocio.com" />
          <Input label="Color de marca" defaultValue="#6366F1" />
        </CardContent>
        <CardFooter className="justify-end">
          <Button variant="secondary" disabled>
            Guardar cambios
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
