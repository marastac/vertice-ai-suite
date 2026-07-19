import { Button } from './Button'
import type { ButtonVariant } from './Button'
import { Modal } from './Modal'

export interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  isConfirming?: boolean
  variant?: Extract<ButtonVariant, 'danger' | 'primary'>
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  isConfirming,
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title} description={description}>
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onCancel} disabled={isConfirming}>
          {cancelLabel}
        </Button>
        <Button variant={variant} onClick={onConfirm} isLoading={isConfirming}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}
