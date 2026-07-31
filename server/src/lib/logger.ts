/**
 * Minimal logger. Never pass secrets (API keys, tokens) to these — callers
 * are responsible for keeping log lines free of credentials.
 */
export const logger = {
  info(message: string, meta?: Record<string, unknown>) {
    console.log(`[info] ${message}`, meta ?? '')
  },
  warn(message: string, meta?: Record<string, unknown>) {
    console.warn(`[warn] ${message}`, meta ?? '')
  },
  error(message: string, meta?: Record<string, unknown>) {
    console.error(`[error] ${message}`, meta ?? '')
  },
}
