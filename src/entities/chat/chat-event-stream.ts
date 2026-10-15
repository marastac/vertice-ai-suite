import type { ChatQualificationResult } from './types'

export interface StreamChatMessageHandlers {
  onDelta: (text: string) => void
  onQualification: (qualification: ChatQualificationResult | null) => void
  onDone: () => void
  onError: (message: string) => void
  /**
   * Fired instead of `onDelta`/`onQualification` when the backend's
   * technical message-count protection has been reached (see
   * server/src/services/chat-service.ts::hasReachedMessageLimit()) — this
   * is a normal, expected end to the conversation, not an error. `message`
   * is a ready-to-display, calm closing message; render it like a regular
   * assistant reply, never like `onError`'s retryable failure banner.
   */
  onLimitReached: (message: string) => void
}

/** Shown when the connection drops (or the server goes away) before the reply finished. */
export const CHAT_STREAM_INTERRUPTED_MESSAGE = 'La respuesta se interrumpió. Comprueba tu conexión e inténtalo de nuevo.'

/**
 * Reads the backend's SSE reply stream (`event:`/`data:` framing — the
 * browser's native EventSource can't send a POST body, so the framing is
 * parsed by hand off the fetch response).
 *
 * Kept free of `import.meta.env` and `fetch` so it can be tested directly
 * (tests/chat-event-stream.test.ts). Guarantees, whatever the stream does:
 *   - it NEVER throws: a dropped connection or a read error becomes one
 *     `onError` (or nothing at all if the caller aborted on purpose), so the
 *     caller's "still streaming" state is always cleared;
 *   - a malformed event is skipped instead of aborting the whole reply;
 *   - a stream that ends without any terminal event (`done`, `error`,
 *     `conversation_limit_reached`) — e.g. the server crashed mid-reply —
 *     is reported once via `onError`, so the visitor gets "Reintentar"
 *     instead of a silently vanished answer.
 */
export async function readChatEventStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamChatMessageHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false

  const handleRawEvent = (rawEvent: string) => {
    const lines = rawEvent.split('\n')
    const eventLine = lines.find((line) => line.startsWith('event: '))
    const dataLine = lines.find((line) => line.startsWith('data: '))
    if (!eventLine || !dataLine) return

    let data: Record<string, unknown>
    try {
      data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return

    const eventType = eventLine.slice('event: '.length).trim()
    if (eventType === 'delta' && typeof data.text === 'string') handlers.onDelta(data.text)
    else if (eventType === 'qualification') handlers.onQualification((data.qualification as ChatQualificationResult) ?? null)
    else if (eventType === 'error' && typeof data.message === 'string') {
      finished = true
      handlers.onError(data.message)
    } else if (eventType === 'conversation_limit_reached' && typeof data.message === 'string') {
      finished = true
      handlers.onLimitReached(data.message)
    } else if (eventType === 'done') {
      finished = true
      handlers.onDone()
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const rawEvents = buffer.split('\n\n')
      buffer = rawEvents.pop() ?? ''
      for (const rawEvent of rawEvents) handleRawEvent(rawEvent)
    }
    buffer += decoder.decode()
    if (buffer.trim()) handleRawEvent(buffer)
  } catch {
    // Read failed (network drop, server reset, or our own abort).
  }

  if (!finished && !signal?.aborted) handlers.onError(CHAT_STREAM_INTERRUPTED_MESSAGE)
}
