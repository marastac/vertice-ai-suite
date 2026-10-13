/**
 * Collapses concurrent calls that share a key into ONE in-flight promise:
 * while a call for `key` is pending, every other call for the same key gets
 * that same promise instead of starting a second run. Once it settles
 * (resolved OR rejected), the next call starts a fresh run — so a failure is
 * never cached and can be retried.
 *
 * Used by OrganizationProvider to avoid firing first-login provisioning
 * twice from the same tab (React StrictMode's double effect, several auth
 * events in a row). This is only a client-side optimisation: the real
 * guarantee against duplicate organizations — including across tabs — is the
 * per-user lock in bootstrap_personal_organization() (see
 * supabase/migrations-org-bootstrap.sql).
 *
 * Deliberately dependency-free (no `@/` imports) so it can be tested on its
 * own.
 */
export function createSingleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>()

  return function run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key)
    if (existing) return existing

    const promise = (async () => {
      try {
        return await task()
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, promise)
    return promise
  }
}
