import { supabase } from '@/shared/lib/supabase-client'
import type { ChatConfigRepository } from './chat-config-repository'
import { createDefaultChatConfiguration } from './defaults'
import type { ChatConfiguration } from './types'

const ORG_SLUG = 'vertice-agency'

interface ChatConfigurationRow {
  assistant_name: string
  welcome_message: string
  agency_description: string
  services_offered: string
  tone: ChatConfiguration['tone']
  language: string
  questions_to_collect: string[]
  criteria: ChatConfiguration['criteria']
  min_qualified_score: number
  additional_instructions: string | null
  is_active: boolean
  updated_at: string
}

function fromRow(row: ChatConfigurationRow): ChatConfiguration {
  return {
    assistantName: row.assistant_name,
    welcomeMessage: row.welcome_message,
    agencyDescription: row.agency_description,
    servicesOffered: row.services_offered,
    tone: row.tone,
    language: row.language,
    questionsToCollect: row.questions_to_collect,
    criteria: row.criteria,
    minQualifiedScore: row.min_qualified_score,
    additionalInstructions: row.additional_instructions ?? undefined,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  }
}

function toRow(config: ChatConfiguration) {
  return {
    org_slug: ORG_SLUG,
    assistant_name: config.assistantName,
    welcome_message: config.welcomeMessage,
    agency_description: config.agencyDescription,
    services_offered: config.servicesOffered,
    tone: config.tone,
    language: config.language,
    questions_to_collect: config.questionsToCollect,
    criteria: config.criteria,
    min_qualified_score: config.minQualifiedScore,
    additional_instructions: config.additionalInstructions ?? null,
    is_active: config.isActive,
  }
}

async function fetchRow(): Promise<ChatConfigurationRow> {
  const { data, error } = await supabase.from('chat_configuration').select('*').eq('org_slug', ORG_SLUG).single()
  if (error) throw error
  return data
}

export const supabaseChatConfigRepository: ChatConfigRepository = {
  async get() {
    const { data, error } = await supabase.from('chat_configuration').select('*').eq('org_slug', ORG_SLUG).maybeSingle()
    if (error) throw error
    if (data) return fromRow(data)

    // Nothing seeded yet for this org. Insert the default and ignore a
    // conflict rather than checking-then-inserting, so two concurrent
    // first-reads can't both try to create the row. ON CONFLICT DO NOTHING
    // never returns the pre-existing row via .select(), regardless of which
    // caller's insert actually won — so every caller re-fetches afterward.
    const { error: seedError } = await supabase
      .from('chat_configuration')
      .upsert(toRow(createDefaultChatConfiguration()), { onConflict: 'org_slug', ignoreDuplicates: true })
    if (seedError) throw seedError

    return fromRow(await fetchRow())
  },

  async save(config) {
    const { error } = await supabase
      .from('chat_configuration')
      .update({ ...toRow(config), updated_at: new Date().toISOString() })
      .eq('org_slug', ORG_SLUG)
    if (error) throw error
    return fromRow(await fetchRow())
  },

  async reset() {
    const { error } = await supabase
      .from('chat_configuration')
      .update({ ...toRow(createDefaultChatConfiguration()), updated_at: new Date().toISOString() })
      .eq('org_slug', ORG_SLUG)
    if (error) throw error
    return fromRow(await fetchRow())
  },
}
