import { activeChatConfigRepository, createChatConfigurationForBusinessType } from '@/entities/chat'
import { activeFormRepository, buildStarterFormInput } from '@/entities/form'
import { activeOrganizationRepository } from './active-organization-repository'
import type { BusinessType, Organization } from './types'

/**
 * The one place that touches three repositories in sequence to complete
 * /onboarding (Phase 9) — same pattern as entities/form/submission-service.ts.
 * Replaces the neutral chat-assistant default with copy tailored to the
 * chosen business type and creates one editable starter form so the
 * organization isn't staring at an empty /forms page on day one, THEN — and
 * only then — marks the organization as onboarded.
 *
 * Order is deliberate and load-bearing, not incidental: these are three
 * independent HTTP calls with no shared transaction, so whichever call
 * happens last is the one whose success actually determines whether the
 * user sees "onboarding complete" or an error. Marking completion first
 * (the original Phase 9 implementation) meant a failure in either setup
 * step left the organization durably stuck "onboarded" with nothing to
 * show for it — exactly what happened when the chat_configuration save
 * used to 406 on organizations with no existing row (fixed separately by
 * making that save() an upsert). Marking completion LAST means any failure
 * here leaves the organization correctly un-onboarded, so retrying
 * "Empezar" is the natural recovery path instead of a manual SQL reset.
 *
 * Known residual limitation: activeFormRepository.create() is not
 * idempotent, so a retry after the chat-config step succeeds but the form
 * step fails will create a second starter form. Acceptable for now — an
 * extra draft form is a harmless cleanup, not a broken state — but worth
 * revisiting if this needs to be made fully idempotent later.
 */
export async function completeOrganizationOnboarding(
  organizationId: string,
  businessType: BusinessType,
): Promise<Organization> {
  await activeChatConfigRepository.save(organizationId, createChatConfigurationForBusinessType(organizationId, businessType))
  await activeFormRepository.create(buildStarterFormInput(organizationId, businessType))
  return activeOrganizationRepository.completeOnboarding(organizationId, businessType)
}
