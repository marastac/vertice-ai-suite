const STORAGE_KEY = 'lead-ai:active-organization:v1'

/**
 * Which organization the user was last working in — read by OrganizationProvider
 * to pick the initial activeOrganizationId (instead of always defaulting to the
 * oldest membership), and written by switchOrganization() and AcceptInvitePage
 * (right before its hard reload, so a just-accepted invite's organization wins).
 * localStorage, not sessionStorage: this should survive a browser restart, unlike
 * pending-invite-storage.ts's short-lived marker. Safe across different users on
 * the same browser — OrganizationProvider only honors this value if the current
 * user is actually a member of it, ignoring it otherwise.
 */
export function getLastActiveOrganizationId(): string | null {
  return localStorage.getItem(STORAGE_KEY)
}

export function setLastActiveOrganizationId(organizationId: string): void {
  localStorage.setItem(STORAGE_KEY, organizationId)
}
