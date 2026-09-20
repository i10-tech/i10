import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { abortPendingWebAuthn, installAbortableWebAuthn } from "../app/_lib/webauthn"

/**
 * Owning the one WebAuthn request a document is allowed to have.
 *
 * ⚠ THE BUG THIS GUARDS IS NOT HYPOTHETICAL AND WAS NOT CHEAP. A browser
 * permits exactly one outstanding `navigator.credentials` call; the sign-in
 * page arms one on mount (conditional mediation, the passkey offered inside the
 * email field's autofill menu) and it stays pending for the life of the
 * document. Since sign-in became the only door, the sign-up runs in that SAME
 * document — so `createPasskey()` four steps later met
 * `OperationError: A request is already pending.`, which clerk-js does not
 * translate and which therefore surfaced as "we could not add a passkey on this
 * device", with no prompt ever shown.
 *
 * ⚠ NO DOM IS NEEDED AND NONE IS USED. Everything here is `globalThis` — the
 * Clerk singleton is a property on it and `navigator.credentials` is reached
 * through it — which matters because this repo has no DOM test environment and
 * adding one to cover three functions would be the larger change.
 */

interface Recorded {
  signal?: AbortSignal
  mediation?: string
}

const calls: Recorded[] = []

/** Resolves only when aborted, exactly as a real conditional request behaves. */
function credentialsStub() {
  return {
    get(options: { signal?: AbortSignal; mediation?: string }) {
      calls.push({ signal: options.signal, mediation: options.mediation })
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        })
      })
    },
  }
}

type Global = typeof globalThis & {
  Clerk?: unknown
  navigator?: unknown
}

const scope = globalThis as Global
let savedNavigator: unknown

beforeEach(() => {
  calls.length = 0
  savedNavigator = scope.navigator
  Object.defineProperty(scope, "navigator", {
    value: { credentials: credentialsStub() },
    configurable: true,
    writable: true,
  })
  scope.Clerk = {}
})

afterEach(() => {
  abortPendingWebAuthn()
  delete scope.Clerk
  Object.defineProperty(scope, "navigator", {
    value: savedNavigator,
    configurable: true,
    writable: true,
  })
})

describe("installing the getter", () => {
  it("reports failure when clerk-js has not attached yet", () => {
    delete scope.Clerk
    // ⚠ THE CALLER RELIES ON THIS `false` TO NOT ARM. Arming without the
    // override hands the controller to clerk-js, which never gives it back.
    expect(installAbortableWebAuthn()).toBe(false)
  })

  it("puts our getter on the singleton and says so", () => {
    expect(installAbortableWebAuthn()).toBe(true)
    expect(
      typeof (scope.Clerk as { __internal_getPublicCredentials?: unknown })
        .__internal_getPublicCredentials,
    ).toBe("function")
  })

  // ⚠ IDENTITY, NOT A FLAG. The first version latched a boolean on the first
  // CALL rather than the first SUCCESS, so it marked itself done while
  // installing on nothing and the override never appeared in the page.
  it("is idempotent without latching a flag", () => {
    installAbortableWebAuthn()
    const first = (scope.Clerk as { __internal_getPublicCredentials?: unknown })
      .__internal_getPublicCredentials
    installAbortableWebAuthn()
    expect(
      (scope.Clerk as { __internal_getPublicCredentials?: unknown })
        .__internal_getPublicCredentials,
    ).toBe(first)
  })

  // ⚠ A FRESH DOCUMENT MUST BE INSTALLABLE AGAIN, which a module-level `true`
  // would have prevented after the first failed attempt.
  it("recovers once the singleton turns up", () => {
    delete scope.Clerk
    expect(installAbortableWebAuthn()).toBe(false)
    scope.Clerk = {}
    expect(installAbortableWebAuthn()).toBe(true)
  })
})

describe("releasing the pending request", () => {
  function armed() {
    installAbortableWebAuthn()
    const getter = (
      scope.Clerk as {
        __internal_getPublicCredentials: (input: {
          publicKeyOptions: unknown
          conditionalUI?: boolean
        }) => Promise<{ publicKeyCredential: unknown; error: Error | null }>
      }
    ).__internal_getPublicCredentials

    return getter({
      publicKeyOptions: { challenge: new Uint8Array(32) },
      conditionalUI: true,
    })
  }

  it("asks for conditional mediation and keeps a signal it can pull", async () => {
    void armed()
    await Promise.resolve()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.mediation).toBe("conditional")
    expect(calls[0]?.signal?.aborted).toBe(false)
  })

  // ⚠ THE WHOLE POINT OF THE FILE. Without this the passkey step has nothing to
  // release and `create()` keeps losing to a request nobody can reach.
  it("aborts the outstanding request", async () => {
    void armed()
    await Promise.resolve()

    abortPendingWebAuthn()
    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  it("is harmless when nothing is pending", () => {
    expect(() => abortPendingWebAuthn()).not.toThrow()
  })

  // ⚠ TWO CONDITIONAL REQUESTS COLLIDE WITH EACH OTHER exactly as one collides
  // with `create()`, so the getter retires the previous one itself.
  it("retires a previous request when a new one is armed", async () => {
    void armed()
    await Promise.resolve()
    void armed()
    await Promise.resolve()

    expect(calls).toHaveLength(2)
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(calls[1]?.signal?.aborted).toBe(false)
  })

  /*
   * ⚠ THE CODE HAS TO SURVIVE IN THE TEXT, because the caller rewraps whatever
   * we return as a generic `passkey_retrieval_failed` and keeps only
   * `.message`. A cancellation that loses its code becomes a failure, and
   * somebody who pressed Cancel is told their passkey did not work — which is
   * the bug `_lib/passkey.ts` exists to prevent, reintroduced from the far end.
   */
  it("carries the mapped code inside the message an abort produces", async () => {
    const pending = armed()
    await Promise.resolve()
    abortPendingWebAuthn()

    const { error } = await pending
    expect(error?.message).toContain('(code="passkey_operation_aborted")')
  })
})
