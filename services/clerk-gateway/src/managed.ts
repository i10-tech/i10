/**
 * Is this person a managed account - one whose company signs them in (SSO)?
 *
 * ⚠ THE INTERFACE IS FINAL; THE ANSWER IS NOT YET. #337 builds the identity
 * core that knows who is managed. Until then the gateway runs with
 * `NOT_MANAGED`, which answers "no" for everybody, so nothing changes for
 * anyone today. The policy for a managed account is already written and tested
 * in policy.ts: self-service account routes refused, every sign-in strategy
 * except `ticket` refused. #337 supplies an implementation of this interface -
 * a call to our API with a shared secret, wrapped in `cached()` below - and
 * changes nothing else.
 *
 * ⚠ A LOOKUP THAT FAILS MUST THROW, NOT ANSWER "NO". The policy turns a thrown
 * error into a 503 (never a 401, never "signed out"). Answering `false` on an
 * outage would wave a managed account past its company's SSO exactly when our
 * API is down, which is the worst moment to open that door.
 */
export interface ManagedAccounts {
  /** A sign-in identifier, already trimmed and lower-cased. */
  byIdentifier(identifier: string): Promise<boolean>
  /** The session a self-service request acts as (`sess_…`). */
  bySession(sessionId: string): Promise<boolean>
}

/** TODO(#337): replace with the API-backed implementation. */
export const NOT_MANAGED: ManagedAccounts = {
  async byIdentifier() {
    return false
  },
  async bySession() {
    return false
  },
}

/**
 * A short, per-isolate cache in front of a lookup, for #337.
 *
 * ⚠ SHORT ON PURPOSE. A person who becomes managed (their company turns on
 * enforcement) should be stopped within `ttlMs`, and an isolate lives for
 * minutes at most, so this is a burst absorber for the token-refresh traffic,
 * not a source of truth. Failures are never cached: the next request asks
 * again.
 */
export function cached(
  inner: ManagedAccounts,
  options: { ttlMs: number; maxEntries?: number; now?: () => number },
): ManagedAccounts {
  const now = options.now ?? Date.now
  const max = options.maxEntries ?? 10_000
  const store = new Map<string, { value: boolean; until: number }>()

  const remember = async (key: string, ask: () => Promise<boolean>) => {
    const hit = store.get(key)
    if (hit && hit.until > now()) return hit.value
    const value = await ask()
    if (store.size >= max) {
      // Oldest first: a Map iterates in insertion order.
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
    store.set(key, { value, until: now() + options.ttlMs })
    return value
  }

  return {
    byIdentifier: (identifier) =>
      remember(`i:${identifier}`, () => inner.byIdentifier(identifier)),
    bySession: (sessionId) =>
      remember(`s:${sessionId}`, () => inner.bySession(sessionId)),
  }
}
