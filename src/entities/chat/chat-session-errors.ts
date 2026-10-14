/**
 * Error handling for starting a public chat session
 * (api-client.ts::createRemoteChatSession). Kept dependency-free — no Vite
 * `import.meta.env`, no `@/` imports — so it can be unit-tested on Node
 * (tests/chat-session-errors.test.ts).
 */

/** Shown when the request never reached the backend (network down, DNS, CORS) — never the browser's raw "Failed to fetch". */
export const CHAT_SESSION_NETWORK_ERROR_MESSAGE =
  'No se pudo conectar con el asistente. Comprueba tu conexión e inténtalo de nuevo.'

/** Fallback when the backend answered with an error but no readable message. */
export const CHAT_SESSION_FALLBACK_ERROR_MESSAGE = 'No se pudo iniciar la conversación. Inténtalo de nuevo.'

/**
 * Whether retrying can help for an HTTP error status. 5xx and 429 are
 * temporary (e.g. a quota that couldn't be verified right now → 503). 4xx
 * such as 403 (chat inactive or the organization's quota exhausted) or 404
 * won't change on retry, so no "Reintentar" button is offered for them.
 */
export function isRetryableSessionStatus(status: number): boolean {
  return status >= 500 || status === 429
}

/** Error from createRemoteChatSession(); `retryable` says whether a "Reintentar" button can help. */
export class ChatSessionError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'ChatSessionError'
    this.retryable = retryable
  }
}
