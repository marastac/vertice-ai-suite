import type { ChatConfiguration } from './types'

/** Row returned by the `get_public_chat_config(p_slug)` RPC — the ONLY chat fields an anonymous visitor may read. */
export interface PublicChatConfigRow {
  organization_id: string
  assistant_name: string
  welcome_message: string
  tone: ChatConfiguration['tone']
  language: string
  is_active: boolean
}

/**
 * Builds the configuration the public /c/:orgSlug page works with from the
 * public RPC row. The organization's private fields (business description,
 * services, questions, qualification criteria, minimum score, additional
 * instructions) are never readable anonymously since
 * supabase/migrations-public-read-hardening.sql, so they're filled with
 * neutral values here. That's safe: the public page only displays the name
 * and welcome message, and a backend with Supabase configured ignores the
 * client's config entirely, loading the real one server-side
 * (server/src/services/chat-service.ts::createSession()).
 *
 * Kept free of the Supabase client so it can be unit-tested directly
 * (tests/public-read-mappers.test.ts).
 */
export function publicChatConfigFromRow(row: PublicChatConfigRow): { config: ChatConfiguration; organizationId: string } {
  return {
    organizationId: row.organization_id,
    config: {
      organizationId: row.organization_id,
      assistantName: row.assistant_name,
      welcomeMessage: row.welcome_message,
      tone: row.tone,
      language: row.language,
      isActive: row.is_active,
      agencyDescription: '',
      servicesOffered: '',
      questionsToCollect: [],
      criteria: [],
      minQualifiedScore: 70,
      updatedAt: '',
    },
  }
}
