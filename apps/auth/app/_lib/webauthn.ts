"use client"

/**
 * Taking ownership of the one WebAuthn request the browser lets us have.
 *
 * ⚠ A DOCUMENT MAY HAVE EXACTLY ONE WEBAUTHN REQUEST IN FLIGHT, AND THE SIGN-IN
 * PAGE ARMS ONE BEFORE ANYBODY TOUCHES ANYTHING. Conditional mediation — the
 * passkey offered inside the email field's own autofill menu — is a
 * `navigator.credentials.get()` that stays PENDING for as long as the page
 * lives, because it is waiting for a choice that may never come. That is not a
 * bug; it is what conditional mediation is.
 *
 * ⚠ AND SINCE SIGN-IN BECAME THE ONLY DOOR, THE SIGN-UP HAPPENS ON THAT SAME
 * DOCUMENT. An unknown address swaps `SignInForm` for `SignUpForm` in place —
 * no navigation, by design, so the card can animate — which means the autofill
 * request armed at mount is STILL PENDING four steps later when the passkey
 * step calls `navigator.credentials.create()`. Chromium answers that with
 *
 *     OperationError: A request is already pending.
 *
 * which clerk-js does not translate, so it arrived as an uncoded exception and
 * was reported as "we could not add a passkey on this device". Verified both
 * ways in a live browser: with a conditional request pending, `createPasskey()`
 * fails with exactly that message; abort it and the same call succeeds.
 *
 * ⚠ THE ABORT HANDLE IS CLERK'S AND IT DOES NOT SHARE IT. clerk-js passes its
 * own `AbortController` into every `navigator.credentials` call and keeps it in
 * a module-private singleton — not on the `Clerk` object, not on `window`, and
 * never fully aborted from anywhere we can reach. A second copy of the same
 * class imported from `@clerk/shared` is a DIFFERENT instance and aborts
 * nothing, because clerk-js is a separate script with its own bundle.
 *
 * ⚠ SO WE SUPPLY THE GETTER INSTEAD OF BORROWING THE CONTROLLER. `signIn`
 * resolves `clerk.__internal_getPublicCredentials` AT CALL TIME and falls back
 * to its own implementation, so assigning ours routes every conditional request
 * through a controller this module holds — and can abort. It is an `__internal_`
 * name and therefore a Clerk upgrade may move it, the same bet already taken in
 * app/layout.tsx; `installed` below fails soft, so a rename costs the fix rather
 * than the page.
 */

/** The controller behind the request currently in flight, if there is one. */
let pending: AbortController | null = null

/**
 * ⚠ THERE IS NO `installed` FLAG, AND THE FIRST VERSION OF THIS FILE HAD ONE.
 * It latched on the first CALL rather than on the first SUCCESS, and the first
 * call happens before clerk-js has attached `window.Clerk` — so it installed on
 * nothing, marked itself done, and the override never appeared. Identity
 * against the singleton's own property is the honest question: it answers "is
 * OUR getter the one that will run", which a boolean set elsewhere cannot.
 */

/**
 * ⚠ THE NAMES CLERK MAPS, MAPPED IDENTICALLY, BECAUSE THE CODE IS THE MESSAGE.
 * The caller rewraps whatever we return as a generic `passkey_retrieval_failed`
 * and keeps only `.message` — so a cancellation that does not carry its own
 * code in its TEXT becomes a failure, and somebody who pressed Cancel is told
 * their passkey did not work. `_lib/passkey.ts` reads `(code="…")` out of the
 * message for exactly this reason; this is the other end of that contract.
 */
const CODE_FOR: Record<string, string> = {
  NotAllowedError: "passkey_retrieval_cancelled",
  AbortError: "passkey_operation_aborted",
  SecurityError: "passkey_invalid_rpID_or_domain",
  NotSupportedError: "passkey_not_supported",
}

function described(error: unknown): Error {
  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : String(error)
  const code = CODE_FOR[name]

  // ⚠ THE CODE IS APPENDED IN CLERK'S OWN SHAPE, not invented. `formatMessage`
  // writes `(code="…")` and `codesIn` reads it back; matching the format is
  // what lets a cancellation stay silent through the rewrap above.
  return new Error(code ? `${message} (code="${code}")` : message)
}

/**
 * Clerk's credential getter, with a controller we can reach.
 *
 * ⚠ THE SHAPE IS CLERK'S AND IS NOT NEGOTIABLE: `{ publicKeyCredential, error }`
 * with a null on whichever side did not happen. Returning a rejected promise
 * instead would skip the caller's own error handling entirely.
 */
async function getPublicCredentials({
  publicKeyOptions,
  conditionalUI,
}: {
  publicKeyOptions: PublicKeyCredentialRequestOptions
  conditionalUI?: boolean
}): Promise<{ publicKeyCredential: Credential | null; error: Error | null }> {
  // ⚠ THE PREVIOUS ONE IS ABORTED FIRST, WHICH IS WHAT CLERK'S OWN SERVICE
  // DOES. Two conditional requests would collide with each other exactly as
  // one collides with `create()`.
  abortPendingWebAuthn()

  const controller = new AbortController()
  pending = controller

  try {
    const credential = await navigator.credentials.get({
      publicKey: publicKeyOptions,
      mediation: conditionalUI ? "conditional" : "optional",
      signal: controller.signal,
    })

    return credential
      ? { publicKeyCredential: credential, error: null }
      : {
          publicKeyCredential: null,
          error: described(
            Object.assign(new Error("Browser failed to get credential"), {
              name: "NotReadableError",
            }),
          ),
        }
  } catch (error) {
    return { publicKeyCredential: null, error: described(error) }
  } finally {
    // ⚠ ONLY IF IT IS STILL OURS. A later request may already have replaced it,
    // and clearing that one would leak a controller nothing can abort.
    if (pending === controller) pending = null
  }
}

/**
 * Route Clerk's passkey reads through a controller this module owns.
 *
 * ⚠ IT MUST WIN THE RACE AGAINST `signIn.passkey()`, NOT MERELY RUN. Whichever
 * getter is in place when the autofill request is armed owns that request's
 * controller for the life of the document; install a moment late and the
 * pending request belongs to clerk-js, `abortPendingWebAuthn` has nothing to
 * abort, and the passkey step fails exactly as before. That is why the caller
 * installs immediately before arming, and why this returns whether it worked.
 *
 * ⚠ `window.Clerk`, NOT THE OBJECT `useClerk()` HANDS BACK. `@clerk/nextjs`
 * returns an *isomorphic* wrapper that queues calls until clerk-js has loaded;
 * a property assigned to it lands on the WRAPPER, while `SignIn.passkey()`
 * reads `BaseResource.clerk.__internal_getPublicCredentials` — the real
 * singleton. Writing to the wrapper is silently ignored, and that is not a
 * hypothetical: the first version of this did it and the override never
 * appeared in the page.
 *
 * @returns `true` once our getter is the one the singleton will call.
 */
export function installAbortableWebAuthn(): boolean {
  const clerk = (globalThis as { Clerk?: unknown }).Clerk
  if (!clerk || typeof clerk !== "object") return false

  const target = clerk as { __internal_getPublicCredentials?: unknown }
  if (target.__internal_getPublicCredentials === getPublicCredentials) return true

  target.__internal_getPublicCredentials = getPublicCredentials
  return true
}

/**
 * Let go of the pending passkey read, so something else may use the browser.
 *
 * ⚠ SAFE TO CALL WHEN NOTHING IS PENDING, and it is deliberately called that
 * way — the passkey step cannot know whether the person reached it through the
 * sign-in form or landed on it directly from a provider round trip, and asking
 * would be a second source of truth about a thing this module already knows.
 *
 * ⚠ ABORTING IS NOT A FAILURE ANYBODY SEES. The conditional request resolves
 * into `_lib/passkey.ts` as `passkey_operation_aborted`, which is in `CANCELLED`
 * — and the sign-in form's own handler discards errors silently regardless,
 * because nobody asked for autofill in the first place.
 */
export function abortPendingWebAuthn(): void {
  if (!pending) return

  const controller = pending
  pending = null
  controller.abort()
}
