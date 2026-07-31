import { cn } from '@/shared/lib/cn'
import { formatChatDateTime } from '@/entities/chat'
import type { ChatMessage } from '@/entities/chat'

export interface ChatBubbleProps {
  message: ChatMessage
  isStreaming?: boolean
}

// Renders message content as plain text only — never dangerouslySetInnerHTML
// — so nothing the model outputs can inject markup into the page.
export function ChatBubble({ message, isStreaming }: ChatBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <div className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm',
          isUser
            ? 'rounded-tr-sm bg-gradient-to-r from-blue-500 to-purple-600 text-white'
            : 'rounded-tl-sm border border-slate-800 bg-slate-800/60 text-slate-100',
        )}
      >
        {message.content || (isStreaming ? '' : ' ')}
        {isStreaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-slate-400 align-middle" />}
      </div>
      <span className="px-1 text-[11px] text-slate-500">{formatChatDateTime(message.createdAt)}</span>
    </div>
  )
}
