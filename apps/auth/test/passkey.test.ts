import { describe, expect, it } from "bun:test"
import { passkeyFailure } from "../app/_lib/passkey"

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
