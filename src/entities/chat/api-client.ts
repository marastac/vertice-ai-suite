import type { ChatConfiguration, ChatQualificationResult } from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787'

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null)
  return (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error) || fallback
}

export interface BackendHealth {
  reachable: boolean
  aiConfigured: boolean
}

export async function checkBackendHealth(): Promise<BackendHealth> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`)
    if (!response.ok) return { reachable: false, aiConfigured: false }
    const data = (await response.json()) as { aiConfigured: boolean }
    return { reachable: true, aiConfigured: Boolean(data.aiConfigured) }
  } catch {
    return { reachable: false, aiConfigured: false }
  }
}

export interface CreateRemoteSessionResult {
  sessionId: string
  welcomeMessage: string
  assistantName: string
}

export async function createRemoteChatSession(orgSlug: string, config: ChatConfiguration): Promise<CreateRemoteSessionResult> {
  const response = await fetch(`${API_BASE_URL}/api/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug, config }),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'No se pudo iniciar la conversación. Inténtalo de nuevo.'))
  }

  return response.json()
}

export interface StreamChatMessageHandlers {
  onDelta: (text: string) => void
  onQualification: (qualification: ChatQualificationResult | null) => void
  onDone: () => void
  onError: (message: string) => void
}

/**
 * Hand-rolled SSE reader: the browser's native EventSource can't send a POST
 * body, so we parse the `event:`/`data:` framing ourselves off the fetch
 * response stream.
 */
export async function streamChatMessage(
  sessionId: string,
  message: string,
  handlers: StreamChatMessageHandlers,
  signal: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal,
    })
  } catch {
    handlers.onError('No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.')
    return
  }

  if (!response.ok || !response.body) {
    handlers.onError(await readErrorMessage(response, 'No se pudo enviar el mensaje. Inténtalo de nuevo.'))
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const rawEvents = buffer.split('\n\n')
    buffer = rawEvents.pop() ?? ''

    for (const rawEvent of rawEvents) {
      const lines = rawEvent.split('\n')
      const eventLine = lines.find((line) => line.startsWith('event: '))
      const dataLine = lines.find((line) => line.startsWith('data: '))
      if (!eventLine || !dataLine) continue

      const eventType = eventLine.slice('event: '.length).trim()
      const data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>

      if (eventType === 'delta' && typeof data.text === 'string') handlers.onDelta(data.text)
      else if (eventType === 'qualification') handlers.onQualification((data.qualification as ChatQualificationResult) ?? null)
      else if (eventType === 'error' && typeof data.message === 'string') handlers.onError(data.message)
      else if (eventType === 'done') handlers.onDone()
    }
  }
}
