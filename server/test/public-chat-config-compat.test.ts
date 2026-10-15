import { describe, expect, it } from 'vitest'
import { createSessionBodySchema } from '../src/schemas/chat.js'

// Since supabase/migrations-public-read-hardening.sql (H2), the public chat
// page only knows an organization's PUBLIC chat fields; the private ones
// arrive neutral (src/entities/chat/public-chat-config.ts). This is the exact
// shape publicChatConfigFromRow() builds — the session-creation body must
// keep accepting it, or every public chat would fail to start.
const publicConfig = {
  organizationId: '5ec00000-0000-4000-8000-00000000000a',
  assistantName: 'Asistente A',
  welcomeMessage: 'Hola, ¿en qué te ayudo?',
  tone: 'friendly',
  language: 'Español',
  isActive: true,
  agencyDescription: '',
  servicesOffered: '',
  questionsToCollect: [],
  criteria: [],
  minQualifiedScore: 70,
  updatedAt: '',
}

describe('session creation accepts the reduced public chat config (H2)', () => {
  it('parses, keeping the public fields', () => {
    const parsed = createSessionBodySchema.safeParse({ orgSlug: 'org-a', config: publicConfig })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.config?.assistantName).toBe('Asistente A')
    expect(parsed.data?.config?.criteria).toEqual([])
  })

  it('still accepts no config at all (backend with Supabase loads its own)', () => {
    expect(createSessionBodySchema.safeParse({ orgSlug: 'org-a' }).success).toBe(true)
  })
})
