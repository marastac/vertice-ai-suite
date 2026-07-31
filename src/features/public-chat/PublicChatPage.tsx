import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { AlertTriangle, Loader2, ShieldCheck, Sparkles } from 'lucide-react'
import { Card, CardContent } from '@/shared/ui/Card'
import { Button } from '@/shared/ui/Button'
import {
  createRemoteChatSession,
  localStorageChatSessionRepository,
  streamChatMessage,
  syncLeadFromQualification,
  useBackendHealthQuery,
  useChatConfigQuery,
} from '@/entities/chat'
import type { ChatMessage, ChatQualificationResult } from '@/entities/chat'
import { ChatBubble } from './components/ChatBubble'
import { ChatComposer } from './components/ChatComposer'

const SUPPORTED_ORG_SLUG = 'vertice-agency'

function ChatShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-vertice-bg px-4 py-10 text-slate-100">
      <div className="flex w-full max-w-2xl flex-col items-center gap-2 pb-6">
        <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
          <Sparkles className="size-4 text-white" />
        </span>
        <span className="text-sm font-semibold text-white">Lead AI</span>
      </div>
      {children}
    </div>
  )
}

function MessagePanel({ title, description }: { title: string; description: string }) {
  return (
    <Card className="w-full max-w-2xl">
      <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
        <h1 className="text-lg font-semibold text-white">{title}</h1>
        <p className="max-w-sm text-sm text-slate-400">{description}</p>
      </CardContent>
    </Card>
  )
}

export function PublicChatPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>()
  const { data: config, isLoading: isConfigLoading } = useChatConfigQuery()
  const { data: health, isLoading: isHealthLoading } = useBackendHealthQuery()

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null)

  const hasCreatedSessionRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const isOrgSupported = orgSlug === SUPPORTED_ORG_SLUG
  const isLoading = isConfigLoading || isHealthLoading
  const canStartChat = Boolean(isOrgSupported && config?.isActive && health?.reachable && health.aiConfigured)

  const bootstrap = useCallback(async () => {
    if (!config || hasCreatedSessionRef.current) return
    hasCreatedSessionRef.current = true
    setIsConnecting(true)
    setConnectError(null)

    try {
      const result = await createRemoteChatSession(SUPPORTED_ORG_SLUG, config)
      await localStorageChatSessionRepository.create({
        id: result.sessionId,
        orgSlug: SUPPORTED_ORG_SLUG,
        assistantName: result.assistantName,
        welcomeMessage: result.welcomeMessage,
      })
      setSessionId(result.sessionId)
      setMessages([
        { id: crypto.randomUUID(), role: 'assistant', content: result.welcomeMessage, createdAt: new Date().toISOString() },
      ])
    } catch (error) {
      hasCreatedSessionRef.current = false
      setConnectError(error instanceof Error ? error.message : 'No se pudo iniciar la conversación.')
    } finally {
      setIsConnecting(false)
    }
  }, [config])

  useEffect(() => {
    if (isLoading || !canStartChat) return
    void bootstrap()
  }, [isLoading, canStartChat, bootstrap])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    return () => abortControllerRef.current?.abort()
  }, [])

  async function handleQualification(currentSessionId: string, qualification: ChatQualificationResult | null) {
    if (!qualification) return
    await localStorageChatSessionRepository.setQualification(currentSessionId, qualification)
    await syncLeadFromQualification(currentSessionId, qualification)
  }

  async function sendMessage(text: string) {
    if (!sessionId || isStreaming) return

    setSendError(null)
    setLastUserMessage(text)

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: new Date().toISOString() }
    setMessages((prev) => [...prev, userMessage])
    await localStorageChatSessionRepository.appendMessage(sessionId, userMessage)

    const assistantMessageId = crypto.randomUUID()
    setMessages((prev) => [
      ...prev,
      { id: assistantMessageId, role: 'assistant', content: '', createdAt: new Date().toISOString() },
    ])
    setIsStreaming(true)

    const controller = new AbortController()
    abortControllerRef.current = controller
    let assistantText = ''

    await streamChatMessage(
      sessionId,
      text,
      {
        onDelta: (delta) => {
          assistantText += delta
          setMessages((prev) => prev.map((m) => (m.id === assistantMessageId ? { ...m, content: assistantText } : m)))
        },
        onQualification: (qualification) => {
          void handleQualification(sessionId, qualification)
        },
        onError: (message) => setSendError(message),
        onDone: () => {},
      },
      controller.signal,
    )

    setIsStreaming(false)

    if (assistantText.trim()) {
      await localStorageChatSessionRepository.appendMessage(sessionId, {
        id: assistantMessageId,
        role: 'assistant',
        content: assistantText,
        createdAt: new Date().toISOString(),
      })
    } else {
      setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId))
    }
  }

  function handleRetryConnect() {
    hasCreatedSessionRef.current = false
    void bootstrap()
  }

  function handleRetrySend() {
    if (lastUserMessage) void sendMessage(lastUserMessage)
  }

  if (isLoading) {
    return (
      <ChatShell>
        <Card className="w-full max-w-2xl p-8">
          <div className="h-6 w-2/3 animate-pulse rounded bg-slate-800/60" />
          <div className="mt-4 h-32 animate-pulse rounded bg-slate-800/60" />
        </Card>
      </ChatShell>
    )
  }

  if (!isOrgSupported) {
    return (
      <ChatShell>
        <MessagePanel
          title="Este chat no está disponible"
          description="El enlace que buscas no existe. Ponte en contacto con la agencia que te lo envió."
        />
      </ChatShell>
    )
  }

  if (!config?.isActive) {
    return (
      <ChatShell>
        <MessagePanel
          title="Este chat no está activo en este momento"
          description="La agencia todavía no ha activado el chat con IA. Vuelve a intentarlo más tarde."
        />
      </ChatShell>
    )
  }

  if (!health?.reachable) {
    return (
      <ChatShell>
        <MessagePanel
          title="No se pudo conectar con el servidor"
          description="El backend de Lead AI no está disponible. Si eres parte del equipo, ejecuta 'npm run dev:server' y recarga la página."
        />
      </ChatShell>
    )
  }

  if (!health.aiConfigured) {
    return (
      <ChatShell>
        <MessagePanel
          title="La IA no está configurada"
          description="El equipo todavía no ha configurado la clave de la API de Anthropic en el servidor (server/.env). El resto de la aplicación sigue funcionando con normalidad."
        />
      </ChatShell>
    )
  }

  if (connectError) {
    return (
      <ChatShell>
        <Card className="w-full max-w-2xl">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertTriangle className="size-8 text-amber-400" />
            <h1 className="text-lg font-semibold text-white">No se pudo iniciar la conversación</h1>
            <p className="max-w-sm text-sm text-slate-400">{connectError}</p>
            <Button onClick={handleRetryConnect}>Reintentar</Button>
          </CardContent>
        </Card>
      </ChatShell>
    )
  }

  if (isConnecting || !sessionId) {
    return (
      <ChatShell>
        <Card className="flex w-full max-w-2xl items-center justify-center gap-2 py-12 text-sm text-slate-400">
          <Loader2 className="size-4 animate-spin" />
          Conectando con el asistente…
        </Card>
      </ChatShell>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-vertice-bg text-slate-100">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
          <Sparkles className="size-4 text-white" />
        </span>
        <div>
          <p className="text-sm font-semibold text-white">{config.assistantName}</p>
          <p className="text-xs text-slate-500">Lead AI</p>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
        {messages.map((message) => (
          <ChatBubble
            key={message.id}
            message={message}
            isStreaming={isStreaming && message.role === 'assistant' && message.id === messages[messages.length - 1]?.id}
          />
        ))}

        {sendError && (
          <div className="flex flex-col items-center gap-2 self-center rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-sm text-red-300">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" />
              {sendError}
            </span>
            <Button size="sm" variant="outline" onClick={handleRetrySend}>
              Reintentar
            </Button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="mx-auto w-full max-w-2xl">
        <ChatComposer disabled={isStreaming} onSend={sendMessage} />
        <p className="flex items-center justify-center gap-1.5 px-4 pb-4 text-center text-[11px] text-slate-500">
          <ShieldCheck className="size-3.5 shrink-0" />
          Esta conversación puede ser compartida con el equipo de la agencia para dar seguimiento a tu solicitud. No
          compartas información sensible que no quieras que se almacene.
        </p>
      </div>
    </div>
  )
}
