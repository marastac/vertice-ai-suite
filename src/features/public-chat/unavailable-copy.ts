/**
 * Copy for the public chat's "can't chat right now" states. The public chat
 * is seen by our customers' visitors, so production copy must stay calm and
 * generic: no backend commands, file paths, env vars or vendor names. The
 * developer hints are only for `npm run dev` (see the two getters below).
 *
 * Dependency-free on purpose so it can be unit-tested on Node
 * (tests/public-chat-copy.test.ts).
 */

export type UnavailableReason = 'backend-unreachable' | 'ai-not-configured'

export interface UnavailableCopy {
  title: string
  description: string
}

const PRODUCTION_COPY: Record<UnavailableReason, UnavailableCopy> = {
  'backend-unreachable': {
    title: 'El asistente no está disponible',
    description: 'No pudimos conectar con el asistente en este momento. Inténtalo de nuevo en unos minutos.',
  },
  'ai-not-configured': {
    title: 'El asistente no está disponible',
    description: 'Este asistente no está disponible en este momento. Inténtalo de nuevo más tarde.',
  },
}

const DEVELOPMENT_COPY: Record<UnavailableReason, UnavailableCopy> = {
  'backend-unreachable': {
    title: 'No se pudo conectar con el servidor',
    description:
      "El backend de MAASTAC AI no está disponible. Si eres parte del equipo, ejecuta 'npm run dev:server' y recarga la página.",
  },
  'ai-not-configured': {
    title: 'La IA no está configurada',
    description:
      'El equipo todavía no ha configurado la clave de la API de Anthropic en el servidor (server/.env). El resto de la aplicación sigue funcionando con normalidad.',
  },
}

/**
 * Two separate functions (not one with an `isDevelopment` flag) on purpose:
 * PublicChatPage picks between them with `import.meta.env.DEV`, which is a
 * build-time constant, so the production bundle tree-shakes
 * getDevelopmentUnavailableCopy() — and DEVELOPMENT_COPY's internal hints —
 * away entirely instead of shipping them unused.
 */
export function getProductionUnavailableCopy(reason: UnavailableReason): UnavailableCopy {
  return PRODUCTION_COPY[reason]
}

export function getDevelopmentUnavailableCopy(reason: UnavailableReason): UnavailableCopy {
  return DEVELOPMENT_COPY[reason]
}

/** Title for a failed session start: a non-retryable failure (403/404) means the assistant is unavailable, not a transient error. */
export function getConnectErrorTitle(retryable: boolean): string {
  return retryable ? 'No se pudo iniciar la conversación' : 'El asistente no está disponible'
}
