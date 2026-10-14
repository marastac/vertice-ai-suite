// Unit tests for src/features/public-chat/unavailable-copy.ts — the public
// chat is seen by our customers' visitors, so production copy must never
// expose internal details (commands, file paths, env vars, vendor names).
// Runs on Node's built-in test runner through the backend's `tsx`:
//   server/node_modules/.bin/tsx --test tests/*.test.ts
// (That the development copy is also ABSENT from the production bundle is
// checked by inspecting `vite build` output — see REPORTE_PRUEBAS_AUTOMATICAS.txt.)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getConnectErrorTitle,
  getDevelopmentUnavailableCopy,
  getProductionUnavailableCopy,
} from '../src/features/public-chat/unavailable-copy.ts'
import type { UnavailableReason } from '../src/features/public-chat/unavailable-copy.ts'

const REASONS: UnavailableReason[] = ['backend-unreachable', 'ai-not-configured']

// Anything a visitor must never read in production.
const INTERNAL_DETAILS = /npm|dev:server|server\/\.env|\.env|anthropic|api key|clave de la api|backend|localhost|si eres parte del equipo/i

test('PRODUCTION copy never exposes internal details, for every unavailable state', () => {
  for (const reason of REASONS) {
    const copy = getProductionUnavailableCopy(reason)
    assert.doesNotMatch(copy.title, INTERNAL_DETAILS, `${reason} title: ${copy.title}`)
    assert.doesNotMatch(copy.description, INTERNAL_DETAILS, `${reason} description: ${copy.description}`)
    assert.ok(copy.title.length > 0 && copy.description.length > 0)
  }
})

test('DEVELOPMENT copy keeps the hints the team needs', () => {
  assert.match(getDevelopmentUnavailableCopy('backend-unreachable').description, /npm run dev:server/)
  assert.match(getDevelopmentUnavailableCopy('ai-not-configured').description, /server\/\.env/)
})

test('a non-retryable session failure (e.g. quota exhausted) reads as "unavailable", not as a transient error', () => {
  assert.equal(getConnectErrorTitle(false), 'El asistente no está disponible')
  assert.equal(getConnectErrorTitle(true), 'No se pudo iniciar la conversación')
})
