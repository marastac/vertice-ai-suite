import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/shared/ui/Button'
import { Textarea } from '@/shared/ui/Textarea'

export interface ChatComposerProps {
  disabled?: boolean
  onSend: (message: string) => void
}

export function ChatComposer({ disabled, onSend }: ChatComposerProps) {
  const [value, setValue] = useState('')

  function handleSend() {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex items-end gap-2 border-t border-slate-800 bg-vertice-surface/80 p-3">
      <Textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Escribe tu mensaje… (Enter para enviar, Shift+Enter para salto de línea)"
        rows={1}
        disabled={disabled}
        className="max-h-32 flex-1"
      />
      <Button
        type="button"
        aria-label="Enviar mensaje"
        onClick={handleSend}
        disabled={disabled || value.trim() === ''}
        isLoading={disabled}
      >
        <Send className="size-4" />
      </Button>
    </div>
  )
}
