import { localStorageFormRepository, localStorageSubmissionRepository } from '@/entities/form'
import { localStorageLeadRepository } from '@/entities/lead'
import { isSupabaseConfigured, supabase } from '@/shared/lib/supabase-client'

export interface MigrationResult {
  forms: number
  leads: number
  submissions: number
}

/**
 * One-time, browser-side export of THIS browser's localStorage data
 * (leads, forms, form submissions — not chat sessions, not chat
 * configuration, see below) into Supabase.
 *
 * This is a separate concern from supabase/seed.sql: that file seeds fresh
 * demo data into an empty database; this function moves a real user's
 * already-accumulated data out of their browser. Preserves original
 * id/createdAt values by inserting directly rather than going through
 * create() (which always mints a fresh id) — Lead.formId/submissionId and
 * FormSubmission.formId/leadId are real cross-references in the exported
 * data, and minting new ids during import would silently break every
 * existing "Ver envío" link.
 *
 * Chat configuration is intentionally NOT migrated here — it's a single
 * settings record, not accumulated data with cross-references, so the
 * simplest safe path is just re-saving it once through /chat-settings
 * after switching VITE_DATA_BACKEND to "supabase" (the Supabase chat-config
 * repository seeds defaults on first read if nothing exists yet).
 *
 * How to run: with VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY set (so
 * Supabase is reachable) and VITE_DATA_BACKEND still "local" (so the app
 * is still reading your real accumulated data), open the browser console
 * on any page of the running app and call:
 *
 *   await migrateLocalDataToSupabase('<your-organization-id>')
 *
 * organizationId (Phase 8) is a required argument, not resolved
 * automatically — this file is a plain module, not a React component, so it
 * has no access to the running app's OrganizationContext. Find your
 * organization id by querying `select id from organizations` in the
 * Supabase SQL editor (or from the one row you should see if you've already
 * signed up and are the sole member so far).
 *
 * Safe to re-run: every insert is an upsert keyed on the original id.
 */
export async function migrateLocalDataToSupabase(organizationId: string): Promise<MigrationResult> {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Supabase no está configurado (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). Revisa tu .env antes de migrar.',
    )
  }
  if (!organizationId) {
    throw new Error('migrateLocalDataToSupabase(organizationId) requiere el id de la organización destino.')
  }

  const [forms, leads, submissions] = await Promise.all([
    localStorageFormRepository.list(organizationId),
    localStorageLeadRepository.list(organizationId),
    localStorageSubmissionRepository.listAll(organizationId),
  ])

  // 1. Forms first — leads.form_id and form_submissions.form_id reference them.
  if (forms.length > 0) {
    const { error } = await supabase.from('forms').upsert(
      forms.map((form) => ({
        id: form.id,
        organization_id: organizationId,
        name: form.name,
        description: form.description ?? null,
        status: form.status,
        questions: form.questions,
        created_at: form.createdAt,
        updated_at: form.updatedAt,
      })),
      { onConflict: 'id' },
    )
    if (error) throw error
  }

  // 2. Leads second — form_submissions.lead_id references them. Leads
  //    reference forms (already inserted above) via form_id, and carry
  //    submission_id as a loose, unenforced column — see supabase/schema.sql
  //    for why that column deliberately has no foreign key.
  if (leads.length > 0) {
    const { error } = await supabase.from('leads').upsert(
      leads.map((lead) => ({
        id: lead.id,
        organization_id: organizationId,
        name: lead.name,
        email: lead.email,
        phone: lead.phone ?? null,
        company: lead.company,
        position: lead.position ?? null,
        source: lead.source,
        status: lead.status,
        score: lead.score,
        estimated_budget: lead.estimatedBudget ?? null,
        assigned_to: lead.assignedTo || null,
        notes: lead.notes ?? null,
        form_id: lead.formId ?? null,
        submission_id: lead.submissionId ?? null,
        chat_session_id: lead.chatSessionId ?? null,
        created_at: lead.createdAt,
        last_activity_at: lead.lastActivityAt,
      })),
      { onConflict: 'id' },
    )
    if (error) throw error

    // Each lead's embedded activity[] becomes lead_activity rows. Cleared
    // per-lead first so re-running this migration doesn't duplicate them.
    const leadIds = leads.map((lead) => lead.id)
    const { error: clearError } = await supabase.from('lead_activity').delete().in('lead_id', leadIds)
    if (clearError) throw clearError

    const activityRows = leads.flatMap((lead) =>
      lead.activity.map((entry) => ({
        organization_id: organizationId,
        lead_id: lead.id,
        message: entry.message,
        created_at: entry.createdAt,
      })),
    )
    if (activityRows.length > 0) {
      const { error: activityError } = await supabase.from('lead_activity').insert(activityRows)
      if (activityError) throw activityError
    }
  }

  // 3. Submissions last — reference both forms and leads, both already inserted.
  if (submissions.length > 0) {
    const { error } = await supabase.from('form_submissions').upsert(
      submissions.map((submission) => ({
        id: submission.id,
        organization_id: organizationId,
        form_id: submission.formId,
        answers: submission.answers,
        score: submission.score,
        lead_id: submission.leadId ?? null,
        submitted_at: submission.submittedAt,
      })),
      { onConflict: 'id' },
    )
    if (error) throw error
  }

  return { forms: forms.length, leads: leads.length, submissions: submissions.length }
}

// Dev-only convenience so this is reachable from the browser console
// without a build step. Never attached in production builds.
if (import.meta.env.DEV) {
  Object.assign(window, { migrateLocalDataToSupabase })
}
