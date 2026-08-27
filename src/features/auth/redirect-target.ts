export interface AuthRedirectLocationState {
  from?: { pathname: string }
}

// Top-level segments actually registered under the AppShell tree in
// router.tsx, plus /accept-invite (its own top-level public route — see
// AcceptInvitePage.tsx, which carries this same state.from when it redirects
// a logged-out visitor to /login or /register). ProtectedRoute stores
// whatever path a logged-out visit hit into location.state.from, and
// LoginPage/RegisterPage redirect back there on success — but that path was
// never validated against the real route table. A stale/bogus from.pathname
// (a dead bookmark, a typo, a browser-suggested URL — anything that isn't
// one of ours) would otherwise send a freshly-authenticated user straight
// back to a 404, forever, since nothing ever clears state.from. Falling back
// to /dashboard for anything not on this list is what actually fixes that,
// regardless of how the bad path got captured in the first place.
const KNOWN_APP_PATH_PREFIXES = [
  '/dashboard',
  '/leads',
  '/forms',
  '/conversations',
  '/chat-settings',
  '/integrations',
  '/team',
  '/settings',
  '/onboarding',
  '/accept-invite',
]

export function resolveRedirectTarget(from: string | undefined): string {
  if (from && KNOWN_APP_PATH_PREFIXES.some((prefix) => from === prefix || from.startsWith(`${prefix}/`))) {
    return from
  }
  return '/dashboard'
}
