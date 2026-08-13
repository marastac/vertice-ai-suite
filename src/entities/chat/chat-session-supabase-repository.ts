import { supabase } from '@/shared/lib/supabase-client'
import type { ChatSessionRepository } from './chat-session-repository'
import type { ChatMessageRole, ChatQualificationResult, ChatSession } from './types'

interface ChatMessageRow {
  id: string
  role: ChatMessageRole
  content: string
  created_at: string
}

interface ChatSessionRow {
  id: string
  organization_id: string
  org_slug: string
  assistant_name: string
  qualification: ChatQualificationResult | null
  lead_id: string | null
  created_at: string
  updated_at: string
  chat_messages: ChatMessageRow[]
}

// Shape returned by create_public_chat_session()'s `returns chat_sessions`
// (see supabase/schema.sql) — the plain chat_sessions row, no joined
// chat_messages (the RPC also writes the first message, but doesn't hand it
// back — see create() below for how the initial message list is built).
interface ChatSessionRpcRow {
  id: string
  organization_id: string
  org_slug: string
  assistant_name: string
  qualification: ChatQualificationResult | null
  lead_id: string | null
  created_at: string
  updated_at: string
}

const SESSION_SELECT = '*, chat_messages(*)'

function fromRow(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    orgSlug: row.org_slug,
    assistantName: row.assistant_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: row.chat_messages
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((message) => ({ id: message.id, role: message.role, content: message.content, createdAt: message.created_at })),
    qualification: row.qualification ?? undefined,
    leadId: row.lead_id ?? undefined,
  }
}

export const supabaseChatSessionRepository: ChatSessionRepository = {
  async list(organizationId) {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select(SESSION_SELECT)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data.map(fromRow)
  },

  async get(organizationId, id) {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select(SESSION_SELECT)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return data ? fromRow(data) : undefined
  },

  /**
   * Calls create_public_chat_session() (see supabase/schema.sql) instead of
   * a plain insert — chat_sessions/chat_messages have no INSERT policy at
   * all, by design (RLS review requested every anonymous write go through a
   * validated SECURITY DEFINER function, not `with check (true)`). The RPC
   * re-derives organization_id (cross-checked against org_slug) and
   * assistant_name/welcome_message from chat_configuration server-side —
   * input.assistantName/welcomeMessage are only used here to render the
   * initial message locally, matching what the RPC persisted from the same
   * (public, already-read) chat_configuration row a moment earlier.
   */
  async create(input) {
    const { data, error } = await supabase.rpc('create_public_chat_session', {
      p_session_id: input.id,
      p_organization_id: input.organizationId,
      p_org_slug: input.orgSlug,
    })
    if (error) throw error

    const row = data as ChatSessionRpcRow
    return {
      id: row.id,
      organizationId: row.organization_id,
      orgSlug: row.org_slug,
      assistantName: row.assistant_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: [{ id: crypto.randomUUID(), role: 'assistant', content: input.welcomeMessage, createdAt: row.created_at }],
      qualification: row.qualification ?? undefined,
      leadId: row.lead_id ?? undefined,
    }
  },

  async appendMessage(id, message) {
    const { error } = await supabase.rpc('append_chat_message', {
      p_session_id: id,
      p_role: message.role,
      p_content: message.content,
    })
    if (error) throw error
  },

  async setQualification(id, qualification) {
    const { error } = await supabase.rpc('set_chat_session_qualification', {
      p_session_id: id,
      p_qualification: qualification,
    })
    if (error) throw error
  },

  async linkLead(id, leadId) {
    const { error } = await supabase.rpc('link_chat_session_lead', {
      p_session_id: id,
      p_lead_id: leadId,
    })
    if (error) throw error
  },
}
