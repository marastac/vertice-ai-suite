// Unit tests for src/entities/chat/chat-session-errors.ts — how a failed
// public-chat session start is classified (retryable or not) and what the
// visitor reads. Runs on Node's built-in test runner through the backend's
// existing `tsx` (no new dependency), from the repository root:
//   server/node_modules/.bin/tsx --test tests/*.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHAT_SESSION_FALLBACK_ERROR_MESSAGE,
  CHAT_SESSION_NETWORK_ERROR_MESSAGE,
  ChatSessionError,
  isRetryableSessionStatus,
} from '../src/entities/chat/chat-session-errors.ts'

test('temporary failures (5xx, 429) are retryable — e.g. a quota that could not be verified right now (503)', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableSessionStatus(status), true, `status ${status}`)
  }
})

test('definitive refusals are NOT retryable — 403 (quota exhausted / chat inactive), 404, 400, 409', () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryableSessionStatus(status), false, `status ${status}`)
  }
})

test('ChatSessionError is a real Error carrying the visitor message and the retry flag', () => {
  const error = new ChatSessionError('Este asistente no está disponible en este momento.', false)
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'ChatSessionError')
  assert.equal(error.message, 'Este asistente no está disponible en este momento.')
  assert.equal(error.retryable, false)
})

test('visitor-facing messages are in Spanish and never the browser\'s raw "Failed to fetch"', () => {
  for (const message of [CHAT_SESSION_NETWORK_ERROR_MESSAGE, CHAT_SESSION_FALLBACK_ERROR_MESSAGE]) {
    assert.doesNotMatch(message, /failed to fetch|typeerror|network error/i)
    assert.match(message, /inténtalo de nuevo/i)
  }
})
