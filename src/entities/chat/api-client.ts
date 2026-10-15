import {
  CHAT_SESSION_FALLBACK_ERROR_MESSAGE,
  CHAT_SESSION_NETWORK_ERROR_MESSAGE,
  ChatSessionError,
  isRetryableSessionStatus,
} from './chat-session-errors'
import { readChatEventStream } from './chat-event-stream'
import type { StreamChatMessageHandlers } from './chat-event-stream'
import type { ChatConfiguration } from './types'

// Re-exported so existing `import { ChatSessionError } from '@/entities/chat'` keeps working.
export { ChatSessionError }
export type { StreamChatMessageHandlers }

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

/**
 * `config` is sent as before (PublicChatPage.tsx always has one by the
 * time it calls this — see usePublicChatConfigQuery()) but is no longer an
 * authority the backend trusts unconditionally: for a real, Supabase-backed
 * organization, the backend loads its `chat_configuration` row itself and
 * ignores this value entirely; it's only ever used as-is when the backend
 * has no Supabase configured at all (local/dev). See server/src/services/
 * chat-service.ts::createSession() for the full trust model — this
 * function's contract with the backend is otherwise unchanged.
 */
export async function createRemoteChatSession(orgSlug: string, config: ChatConfiguration): Promise<CreateRemoteSessionResult> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug, config }),
    })
  } catch {
    // A network failure surfaces as a raw browser TypeError ("Failed to
    // fetch") — never show that to a visitor.
    throw new ChatSessionError(CHAT_SESSION_NETWORK_ERROR_MESSAGE, true)
  }

  if (!response.ok) {
    throw new ChatSessionError(
      await readErrorMessage(response, CHAT_SESSION_FALLBACK_ERROR_MESSAGE),
      isRetryableSessionStatus(response.status),
    )
  }

  return response.json()
}

/**
 * Sends one chat message and streams the reply. The SSE parsing itself lives
 * in chat-event-stream.ts::readChatEventStream(), which never throws and
 * always reports how the reply ended (done, error, limit reached, or an
 * interrupted stream) — except after an intentional abort.
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
    if (!signal.aborted) handlers.onError('No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.')
    return
  }

  if (!response.ok || !response.body) {
    handlers.onError(await readErrorMessage(response, 'No se pudo enviar el mensaje. Inténtalo de nuevo.'))
    return
  }

  await readChatEventStream(response.body, handlers, signal)
}
