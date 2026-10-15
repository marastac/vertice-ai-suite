// Tests for the mappers of the two public read RPCs introduced by
// supabase/migrations-public-read-hardening.sql (H2): get_public_form() and
// get_public_chat_config(). Node's built-in test runner through the
// backend's `tsx` (included in `npm run test:all:safe`). No network.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicChatConfigFromRow } from '../src/entities/chat/public-chat-config.ts'
import { isPossibleFormId, publicFormFromRow } from '../src/entities/form/public-form.ts'

const ORG = '5ec00000-0000-4000-8000-00000000000a'

test('public chat config: exposes only the public fields, private ones come back neutral', () => {
  const { config, organizationId } = publicChatConfigFromRow({
    organization_id: ORG,
    assistant_name: 'Asistente A',
    welcome_message: 'Hola',
    tone: 'friendly',
    language: 'Español',
    is_active: true,
  })
  assert.equal(organizationId, ORG)
  assert.equal(config.organizationId, ORG)
  assert.equal(config.assistantName, 'Asistente A')
  assert.equal(config.welcomeMessage, 'Hola')
  assert.equal(config.isActive, true)
  assert.equal(config.agencyDescription, '')
  assert.equal(config.servicesOffered, '')
  assert.deepEqual(config.criteria, [])
  assert.deepEqual(config.questionsToCollect, [])
  assert.equal(config.additionalInstructions, undefined)
})

test('public chat config: still satisfies what the backend session schema requires (names, tone, score range)', () => {
  const { config } = publicChatConfigFromRow({
    organization_id: ORG,
    assistant_name: 'Asistente A',
    welcome_message: 'Hola',
    tone: 'professional',
    language: 'Español',
    is_active: false,
  })
  assert.ok(config.assistantName.trim().length >= 2 && config.welcomeMessage.trim().length >= 2)
  assert.ok(config.minQualifiedScore >= 0 && config.minQualifiedScore <= 100)
  assert.equal(config.isActive, false)
})

test('public form: keeps questions, order, options and required flags; scoring is never present', () => {
  const form = publicFormFromRow({
    id: '5ec00000-0000-4000-8000-0000000000f1',
    organization_id: ORG,
    name: 'Activo A',
    description: null,
    status: 'active',
    questions: [
      { id: 'q1', type: 'email', label: 'Email', required: true },
      { id: 'q2', type: 'single_choice', label: 'Presupuesto', required: false, options: [{ id: 'o1', label: 'Bajo' }, { id: 'o2', label: 'Alto' }] },
    ],
    created_at: '2026-10-14T00:00:00Z',
    updated_at: '2026-10-14T00:00:00Z',
  })
  assert.equal(form.description, undefined)
  assert.deepEqual(form.questions.map((q) => q.id), ['q1', 'q2'])
  assert.equal(form.questions[0].required, true)
  assert.equal(form.questions[0].options, undefined)
  assert.deepEqual(form.questions[1].options?.map((o) => o.label), ['Bajo', 'Alto'])
  assert.ok(form.questions.every((q) => q.points === undefined))
  assert.ok(form.questions[1].options?.every((o) => o.points === 0))
})

test('public form: an id that cannot be a form id is "not found" before any database call', () => {
  assert.equal(isPossibleFormId('5ec00000-0000-4000-8000-0000000000f1'), true)
  for (const bad of ['', 'abc', '1; drop table forms', '5ec00000-0000-4000-8000-0000000000f1x']) {
    assert.equal(isPossibleFormId(bad), false, bad)
  }
})
