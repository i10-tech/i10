import { describe, expect, it } from "bun:test"
import { passkeyFailure, passkeyReference } from "../app/_lib/passkey"

/**
 * What a passkey prompt is allowed to say when it does not end in a passkey.
 *
 * ⚠ THE FIXTURES ARE REAL ERRORS, NOT INVENTED ONES. Every `message` below was
 * either produced by `ClerkError.formatMessage` — which is why the codes appear
 * inside the text — or reported from a live sign-in. The double-coded one in
 * particular is copied verbatim out of a bug report, and it is the case that a
 * hand-written `error.code` check gets wrong.
 *
 * ⚠ AND `null` IS THE ASSERTION THAT MATTERS MOST. Three of these are somebody
 * pressing Cancel, and a test that only checked the wording of the others would
 * pass just as happily with a toast over each of them.
 */

/** How Clerk hands us a wrapped WebAuthn rejection. */
const clerkError = (code: string, message: string) =>
  Object.assign(new Error(message), { name: "ClerkWebAuthnError", code })

describe("somebody who said no", () => {
  it("says nothing when the sign-in sheet is dismissed", () => {
    const error = clerkError(
      "passkey_retrieval_cancelled",
      'Clerk: The operation either timed out or was not allowed. (code="passkey_retrieval_cancelled")',
    )
    expect(passkeyFailure(error, "use")).toBeNull()
  })

  /*
   * ⚠ THE ONE THE OLD CODE GOT WRONG. clerk-js re-wraps the cancellation in a
   * generic `passkey_retrieval_failed`, so `code` says "failed" and only the
   * copied message still says "cancelled" — reading the code alone reports a
   * failure to somebody who pressed Cancel.
   */
  it("says nothing when the cancellation arrives inside a generic wrapper", () => {
    const error = clerkError(
      "passkey_retrieval_failed",
      "Clerk: The operation either timed out or was not allowed. See: " +
        "https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client. " +
        '(code="passkey_retrieval_cancelled")\n\n(code="passkey_retrieval_failed")',
    )
    expect(passkeyFailure(error, "use")).toBeNull()
  })

  it("says nothing when the sign-up sheet is dismissed", () => {
    const error = clerkError(
      "passkey_registration_cancelled",
      'Clerk: The operation either timed out or was not allowed. (code="passkey_registration_cancelled")',
    )
    expect(passkeyFailure(error, "add")).toBeNull()
  })

  // ⚠ THE UNWRAPPED PATH STILL EXISTS — a navigation mid-prompt aborts before
  // Clerk sees it, and what arrives is the browser's own exception.
  it("says nothing about a raw NotAllowedError", () => {
    const error = Object.assign(new Error("The operation was not allowed"), {
      name: "NotAllowedError",
    })
    expect(passkeyFailure(error, "use")).toBeNull()
  })
})

describe("a passkey that genuinely could not be used", () => {
  it("tells somebody they already have one on this device", () => {
    const error = clerkError("passkey_already_exists", "Clerk: already registered")
    expect(passkeyFailure(error, "add")).toBe(
      "This device already has a passkey for your account.",
    )
  })

  /*
   * ⚠ OUR FAULT, AND THE SENTENCE SAYS SO. A relying-party id that does not
   * match the page is a setting on the Clerk instance; "try again" would send
   * somebody round a loop that cannot end.
   */
  it("owns a domain misconfiguration rather than blaming the device", () => {
    const error = clerkError("passkey_invalid_rpID_or_domain", "Clerk: bad rpID")
    expect(passkeyFailure(error, "use")).toContain("support@i10.tech")
  })

  it("points a browser with no passkey support elsewhere", () => {
    const error = clerkError("passkey_not_supported", "Clerk: unsupported")
    expect(passkeyFailure(error, "use")).toBe(
      "This browser cannot use passkeys. Try another way in.",
    )
  })
})

describe("anything else", () => {
  /*
   * ⚠ THE TWO FALLBACKS DIFFER BECAUSE THE NEXT STEP DIFFERS. Failing to ADD
   * one leaves an account that is already safe and can be revisited in
   * settings; failing to USE one leaves somebody outside, needing another door.
   */
  it("sends a failed registration to settings", () => {
    const error = clerkError("passkey_registration_failed", "Clerk: browser failed")
    expect(passkeyFailure(error, "add")).toContain("later from settings")
  })

  it("sends a failed retrieval to another way in", () => {
    const error = clerkError("passkey_retrieval_failed", "Clerk: browser failed")
    expect(passkeyFailure(error, "use")).toContain("another way in")
  })

  // ⚠ THE FALLBACK IS FOR CODES WE HAVE NEVER SEEN, and Clerk's passkey
  // endpoint answers with API codes as well as WebAuthn ones. This is the
  // branch that was reaching customers with nothing in it to report back.
  it("falls back for a code that is not in the vocabulary at all", () => {
    const error = clerkError("form_param_nil", "Clerk: nope")
    expect(passkeyFailure(error, "add")).toContain("later from settings")
    expect(passkeyFailure(error, "use")).toBe(
      "That passkey did not work. Try another way in.",
    )
  })

  it("never shows Clerk's own developer string", () => {
    const error = clerkError(
      "passkey_retrieval_failed",
      'Clerk: Browser failed to get credential (code="passkey_retrieval_failed")',
    )
    expect(passkeyFailure(error, "use")).not.toContain("(code=")
  })

  // ⚠ READ DEFENSIVELY, because a catch arm catches whatever was thrown.
  it("copes with something that is not an error at all", () => {
    expect(passkeyFailure(null, "use")).toBe(
      "That passkey did not work. Try another way in.",
    )
    expect(passkeyFailure("nope", "add")).toContain("later from settings")
  })
})

/**
 * The code that goes under the sentence.
 *
 * ⚠ THE POINT IS THE UNRECOGNISED CASE. Every fixture above that lands on a
 * named reason is already answerable; the report that arrives as "it still does
 * not work" is one of these, and without the code there is nothing to look up.
 */
describe("the reference somebody can quote back", () => {
  it("carries the code for a failure we could not name", () => {
    expect(passkeyReference(clerkError("form_param_nil", "Clerk: nope"))).toBe(
      "form_param_nil",
    )
  })

  it("prefers the passkey code when Clerk sends several", () => {
    const error = Object.assign(new Error("Clerk: nope"), {
      errors: [{ code: "form_param_nil" }, { code: "passkey_registration_failed" }],
    })
    expect(passkeyReference(error)).toBe("passkey_registration_failed")
  })

  // ⚠ NOTHING TO QUOTE FOR SOMEBODY WHO PRESSED CANCEL, because nothing is
  // shown to them at all. A reference under a message that does not exist is a
  // code floating on its own in a toast.
  it("has nothing to say about a cancellation", () => {
    const error = clerkError(
      "passkey_retrieval_failed",
      'Clerk: not allowed (code="passkey_retrieval_cancelled")',
    )
    expect(passkeyReference(error)).toBeUndefined()
  })

  it("copes with something that is not an error at all", () => {
    expect(passkeyReference(null)).toBeUndefined()
  })
})

/**
 * The challenge that never arrived.
 *
 * ⚠ THE FIXTURE IS CLERK-JS'S OWN STRING, COPIED FROM THE BUNDLE. It is thrown
 * by `errorThrower` inside `Passkey.registerPasskey()` when FAPI answers the
 * challenge request without a nonce, and it is a BARE `Error`: no `code`, no
 * `errors[]`, no `(code="…")` fragment. That is what let it fall through every
 * reader in the file and come out as the generic sentence with a blank
 * reference — the exact pair of symptoms in the report, no system sheet and no
 * code to quote.
 */
const missingPublicKey = () =>
  new Error(
    "Clerk: Missing publicKey. When calling 'navigator.credentials.create()' " +
      "it is required to pass a publicKey object.",
  )

describe("a challenge our side never produced", () => {
  // ⚠ THE DEVICE IS NOT MENTIONED, AND THAT IS THE WHOLE FIX. No sheet was ever
  // opened, so there is nothing about the device to report — the old sentence
  // sent somebody to go and check hardware that was never asked to do anything.
  it("owns the failure instead of blaming the device", () => {
    const reason = passkeyFailure(missingPublicKey(), "add")
    expect(reason).toContain("our side")
    expect(reason).toContain("support@i10.tech")
    expect(reason).not.toContain("this device")
  })

  it("says the same thing on the sign-in side", () => {
    expect(passkeyFailure(missingPublicKey(), "use")).toContain("our side")
  })

  // ⚠ THE SIGN-IN HALF ARRIVES CODED, and has to reach the same sentence by the
  // other road — `REASONS` rather than the message match.
  it("reaches it by the code when clerk-js supplies one", () => {
    const error = clerkError(
      "missing_public_key_options",
      "Clerk: Missing public key options",
    )
    expect(passkeyFailure(error, "use")).toContain("our side")
  })

  // ⚠ THE REFERENCE IS THE OTHER HALF OF THE REPORT. A blank line under this
  // message is what made the original report unanswerable.
  it("carries a reference despite having no code anywhere", () => {
    expect(passkeyReference(missingPublicKey())).toBe("i10_passkey_no_challenge")
  })

  // ⚠ A NAMED CODE STILL WINS. The message match is the weakest reader here and
  // must never overrule an error that identified itself properly.
  it("does not overrule an error that named itself", () => {
    const error = clerkError(
      "passkey_already_exists",
      'Clerk: Missing publicKey. (code="passkey_already_exists")',
    )
    expect(passkeyFailure(error, "add")).toBe(
      "This device already has a passkey for your account.",
    )
  })
})

describe("an error carrying no code at all", () => {
  // ⚠ `SyntaxError` AND `TypeError` ARE DIFFERENT BUGS, and before this the
  // toast could not tell us which one somebody had hit.
  it("falls back to the exception name so the report says something", () => {
    const error = Object.assign(new Error("Unexpected token < in JSON"), {
      name: "SyntaxError",
    })
    expect(passkeyReference(error)).toBe("SyntaxError")
    expect(passkeyFailure(error, "add")).toContain("later from settings")
  })
})

/**
 * The step-up policy, arriving as a 403 that nothing intercepted.
 *
 * ⚠ THE FIXTURE IS A REAL PRODUCTION ERROR, read out of a live console. Adding
 * a passkey is a protected operation on an instance with reverification on, so
 * FAPI answers with a 403 whose `code` is the ENVELOPE — `ClerkAPIResponseError`
 * stamps `api_response_error` on everything it wraps — and whose meaning sits
 * one level down in `errors[]`. `PasskeyStep` wraps the call in Clerk's
 * `useReverification` so this is normally swallowed and replayed; these are the
 * assertions for the occasion it is not.
 */
const reverificationRequired = () =>
  Object.assign(
    new Error("You need to provide additional verification to perform this operation"),
    {
      code: "api_response_error",
      errors: [
        {
          code: "session_reverification_required",
          message: "Reverification required",
          longMessage:
            "You need to provide additional verification to perform this operation",
        },
      ],
    },
  )

describe("a step-up policy that reached the toast", () => {
  // ⚠ A POLICY IS NOT A BROKEN DEVICE. This is the sentence the reported bug
  // actually produced, and the device had nothing to do with it.
  it("does not blame the device for a policy decision", () => {
    const reason = passkeyFailure(reverificationRequired(), "add")
    expect(reason).toContain("confirm it is you")
    expect(reason).not.toContain("could not add a passkey on this device")
  })

  // ⚠ THE ENVELOPE MUST NOT WIN. `api_response_error` is on every Clerk API
  // error alike and names nothing, so a report carrying it is no better than a
  // report carrying nothing.
  it("quotes the code that means something, not the envelope", () => {
    expect(passkeyReference(reverificationRequired())).toBe(
      "session_reverification_required",
    )
  })
})

/**
 * The authenticator that was asked and refused.
 *
 * ⚠ `OperationError` IS THE ONE FROM THE REPORT. clerk-js maps four DOM
 * exceptions and lets the rest through untouched, so this arrives as the raw
 * browser exception with no code anywhere — and it was only identified because
 * the reference line now falls back to the exception name. Its signature is
 * that NO system prompt appears: a passkey provider that claims the request
 * answers it before the operating system draws anything.
 */
const domError = (name: string, message = "The operation failed") =>
  Object.assign(new Error(message), { name })

describe("an authenticator that refused", () => {
  it("names the password manager, because that is the part somebody can change", () => {
    const reason = passkeyFailure(domError("OperationError"), "add")
    expect(reason).toContain("password manager")
    expect(reason).not.toContain("could not add a passkey on this device")
  })

  it("says the other sentence on the sign-in side", () => {
    expect(passkeyFailure(domError("OperationError"), "use")).toContain(
      "hand over the passkey",
    )
  })

  // ⚠ THE SIBLINGS CLERK ALSO LETS THROUGH UNTOUCHED, for the same reason and
  // with the same answer.
  it("covers the rest of the untranslated family", () => {
    for (const name of ["NotReadableError", "UnknownError", "ConstraintError"]) {
      expect(passkeyFailure(domError(name), "add")).toContain("password manager")
    }
  })

  // ⚠ THE NAME IS THE REPORT. Without it this failure is indistinguishable from
  // every other unknown, which is exactly the state it was found in.
  it("quotes the exception name so the report identifies it", () => {
    expect(passkeyReference(domError("OperationError"))).toBe("OperationError")
  })

  // ⚠ A MAPPED EXCEPTION STILL WINS. `NotAllowedError` is somebody pressing
  // Cancel and must stay silent, not become a password-manager sentence.
  it("does not swallow a cancellation", () => {
    expect(passkeyFailure(domError("NotAllowedError"), "add")).toBeNull()
  })
})
