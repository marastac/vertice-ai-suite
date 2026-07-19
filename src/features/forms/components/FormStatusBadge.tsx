import { Badge } from '@/shared/ui/Badge'
import { formStatusBadgeVariant, formStatusLabel } from '@/entities/form'
import type { FormStatus } from '@/entities/form'

export interface FormStatusBadgeProps {
  status: FormStatus
}

export function FormStatusBadge({ status }: FormStatusBadgeProps) {
  return <Badge variant={formStatusBadgeVariant[status]}>{formStatusLabel[status]}</Badge>
}
