const STORAGE_KEY = 'lead-ai:pending-invite:v1'
// Protects auto-provisioning only during the invite-acceptance round trip
// (login/register/email-confirmation) — the invite itself still expires
// after 7 days via organization_invites.expires_at, independent of this.
const TTL_MS = 60 * 60 * 1000

interface StoredPendingInvite {
  token: string
  startedAt: number
}

/** Called by AcceptInvitePage on mount, regardless of auth state — see OrganizationProvider.tsx's auto-provisioning guard. */
export function setPendingInviteToken(token: string): void {
  const value: StoredPendingInvite = { token, startedAt: Date.now() }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
}

/** Returns the token only if it was set within the last hour; a stale entry (abandoned flow) is treated as absent. */
export function getPendingInviteToken(): string | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const stored = JSON.parse(raw) as StoredPendingInvite
    if (Date.now() - stored.startedAt > TTL_MS) return null
    return stored.token
  } catch {
    return null
  }
}

export function clearPendingInviteToken(): void {
  sessionStorage.removeItem(STORAGE_KEY)
}
