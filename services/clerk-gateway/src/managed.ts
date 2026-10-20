/**
 * Is this person a managed account - one whose company signs them in (SSO)?
 *
 * ⚠ ANSWERED BY OUR API (#337), NOT BY THE GATEWAY. `apiManaged` below asks
 * `POST /internal/identity/managed` with the shared secret, wrapped in
 * `cached()`; the policy for a managed account is in policy.ts (self-service
 * account routes refused, every sign-in strategy except `ticket` refused) and
 * did not change when this was wired.
 *
 * ⚠ A LOOKUP THAT FAILS MUST THROW, NOT ANSWER "NO". The policy turns a thrown
 * error into a 503 (never a 401, never "signed out"). Answering `false` on an
 * outage would wave a managed account past its company's SSO exactly when our
 * API is down, which is the worst moment to open that door. An unconfigured
 * gateway (no `I10_API_URL` or `I10_API_SECRET`) throws on every lookup too.
 */
export interface ManagedAccounts {
  /** A sign-in identifier, already trimmed and lower-cased. */
  byIdentifier(identifier: string): Promise<boolean>
  /** The session a self-service request acts as (`sess_…`). */
  bySession(sessionId: string): Promise<boolean>
}

/** Nobody is managed. For the tests only: the Worker always asks the API. */
export const NOT_MANAGED: ManagedAccounts = {
  async byIdentifier() {
    return false
  },
  async bySession() {
    return false
  },
}

export interface ApiManagedOptions {
  /** Our API's origin, e.g. `https://api.i10.tech`. Unset: every lookup throws. */
  url: string | undefined
  /** `IDENTITY_GATEWAY_SECRET` on the API side. Unset: every lookup throws. */
  secret: string | undefined
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** How long to wait for our API before the lookup fails (and the policy says 503). */
  timeoutMs?: number
}

/**
 * The lookup, against our API.
 *
 * ⚠ ONLY `{ managed: true | false }` FROM A 200 IS AN ANSWER. Any other
 * status, a body of any other shape, a timeout or a network error throws.
 */
export function apiManaged(options: ApiManagedOptions): ManagedAccounts {
  const ask = async (body: Record<string, string>): Promise<boolean> => {
    if (!options.url || !options.secret)
      throw new Error("managed lookup is not configured")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000)
    try {
      const response = await options.fetch(
        `${options.url.replace(/\/+$/, "")}/internal/identity/managed`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      )
      if (response.status !== 200)
        throw new Error(`managed lookup answered ${response.status}`)
      const answer = (await response.json()) as { managed?: unknown }
      if (typeof answer?.managed !== "boolean")
        throw new Error("managed lookup answered nonsense")
      return answer.managed
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    byIdentifier: (identifier) => ask({ identifier }),
    bySession: (sessionId) => ask({ sessionId }),
  }
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
