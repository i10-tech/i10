/**
 * What to say when a passkey prompt does not end in a passkey.
 *
 * ⚠ CLERK WRAPS THE BROWSER'S ERROR, AND EVERY CALLER HERE WAS CHECKING THE
 * UNWRAPPED ONE. WebAuthn rejects with a `DOMException` — `NotAllowedError`
 * for "the person said no", `InvalidStateError` for "this device already has
 * one" — and both call sites branched on `error.name` to tell those apart.
 * They cannot: `@clerk/shared` maps each of those exceptions to a
 * `ClerkWebAuthnError` whose `name` is `"ClerkWebAuthnError"` and whose real
 * meaning moves into `code`. So the branch never matched, and pressing Cancel
 * on the operating system's own sheet was reported as a failure — on sign-up
 * as "We could not add a passkey on this device", and on sign-in as Clerk's
 * raw developer string, brackets and all:
 *
 *   Clerk: The operation either timed out or was not allowed. See:
 *   https://www.w3.org/TR/webauthn-2/… (code="passkey_retrieval_cancelled")
 *
 * ⚠ THE CODES ARE READ FROM THE MESSAGE TOO, AND THAT IS NOT PARANOIA — IT IS
 * THE ONLY PLACE THE REAL REASON SURVIVES. clerk-js re-wraps the mapped error
 * a second time on the sign-in path, and the outer wrapper's `code` is the
 * generic `passkey_retrieval_failed`; `ClerkError.formatMessage` appends
 * `(code="…")` to the text it copies, so the inner `passkey_retrieval_cancelled`
 * exists only as a fragment of the outer one's message. The string above is a
 * real report and carries both. Reading `code` alone would call a cancellation
 * a failure, which is the whole bug one level up.
 *
 * ⚠ AND DISMISSING THE SHEET IS NOT AN ERROR. WebAuthn deliberately returns
 * the same rejection for "declined" and "timed out" so a site cannot tell them
 * apart and fingerprint people by it — which means silence is the only correct
 * response to both, and it is also what somebody who pressed Cancel expects.
 * `null` is that silence, and it is a return value rather than a thrown thing
 * so a caller cannot forget to handle it.
 */

/** The whole vocabulary, from @clerk/shared/errors/webAuthNError.d.ts. */
const CANCELLED = new Set([
  "passkey_registration_cancelled",
  "passkey_retrieval_cancelled",
  "passkey_operation_aborted",
])

/**
 * What to say when the challenge never arrived.
 *
 * ⚠ IT DOES NOT BLAME THE DEVICE, BECAUSE THE DEVICE WAS NEVER ASKED. A passkey
 * is created in two halves: clerk-js fetches a challenge from FAPI, and only
 * then opens the platform's sheet. This is the first half failing, so no sheet
 * ever appears — and "we could not add a passkey on this device" told somebody
 * whose device is fine to go and look at their device. It is the same trade as
 * `passkey_invalid_rpID_or_domain`: when the fault is ours, the sentence says
 * so and points at the one route that can actually resolve it.
 *
 * ⚠ AND IT DOES NOT SAY "TRY AGAIN" FIRST. Trying again re-runs the identical
 * request against the identical configuration; offering it as the primary
 * advice is sending somebody round a loop we already know the shape of.
 */
const OURS =
  "We could not start a passkey — that is our side, not your device. Email support@i10.tech and we will fix it."

/**
 * ⚠ EVERY SENTENCE NAMES A DIFFERENT NEXT STEP, which is the point of having
 * more than one. "Something went wrong" is true of all four of these and tells
 * nobody whether to try again, use another device, or write to us.
 */
const REASONS: Record<string, string> = {
  passkey_already_exists: "This device already has a passkey for your account.",
  /*
   * ⚠ THE GENERIC PAIR IS NAMED RATHER THAN LEFT TO THE FALLBACK, because
   * they mean something the fallback does not: the prompt RAN and the browser
   * came back with nothing. `webAuthnCreateCredential` raises the first when
   * `navigator.credentials.create()` resolves empty. "Try again" is honest
   * advice for that and is not honest advice for an unrecognised code.
   */
  passkey_registration_failed:
    "Your device did not finish creating the passkey. Try again, or add one later from settings.",
  passkey_retrieval_failed:
    "Your device did not hand over the passkey. Try again, or use another way in.",
  /*
   * ⚠ OUR MISCONFIGURATION, AND IT SAYS SO RATHER THAN BLAMING THE DEVICE. A
   * relying-party id that does not match the page's domain is a setting on the
   * Clerk instance; no amount of trying again from the customer's side will
   * move it, so "try again" would be false advice.
   */
  passkey_invalid_rpID_or_domain:
    "Passkeys are not set up for this address yet. Email support@i10.tech and we will fix it.",
  passkey_not_supported: "This browser cannot use passkeys. Try another way in.",
  passkey_pa_not_supported:
    "This device has no fingerprint, face or screen-lock unlock to use. Try another way in.",
  /*
   * ⚠ THE SIGN-IN HALF OF THE MISSING CHALLENGE, AND IT IS THE HALF THAT HAS A
   * CODE. Both flows ask FAPI for a challenge before touching the platform, and
   * both can be answered without one — but clerk-js raises this one as a coded
   * `ClerkRuntimeError` and the sign-up one as a bare `Error`. See
   * `MISSING_CHALLENGE` below, which is the same failure wearing no code.
   */
  missing_public_key_options: OURS,
  /*
   * ⚠ A SAFETY NET UNDER `useReverification`, NOT A REPLACEMENT FOR IT. Adding
   * a passkey is a protected operation on an instance with reverification on,
   * so FAPI answers `POST /v1/me/passkeys` with a 403 carrying this code — and
   * `PasskeyStep` wraps the call in Clerk's hook precisely so that the 403 is
   * swallowed, the step-up prompt is shown, and the call is replayed. Nothing
   * here should ever run.
   *
   * ⚠ WHICH IS EXACTLY WHY IT IS WRITTEN DOWN. It was NOT here, so on the one
   * occasion the hook did not intercept — a real 403, observed in production,
   * reported from a live console — the code fell past every reader in this file
   * and came out as "we could not add a passkey on this device". A step-up
   * policy is not a broken device, and the person is not out of options: the
   * sentence says what the system wants and that the account is unharmed.
   *
   * ⚠ AND IT SAYS "ADD ONE FROM SETTINGS" RATHER THAN "TRY AGAIN", because
   * pressing the same button repeats the same unintercepted 403. Settings is a
   * fresh page with a fresh session and is the route that actually works.
   */
  session_reverification_required:
    "We need you to confirm it is you before adding a passkey. Your account is fine — add one from settings and we will ask you there.",
}

/**
 * The one failure clerk-js raises with no code on it anywhere.
 *
 * ⚠ THIS IS THE BUG THIS FILE WAS REOPENED FOR, AND IT IS INVISIBLE TO EVERY
 * OTHER READER HERE. `Passkey.registerPasskey()` asks FAPI for a challenge, and
 * when the answer comes back without one it raises a BARE `Error`:
 *
 *   Clerk: Missing publicKey. When calling 'navigator.credentials.create()'
 *   it is required to pass a publicKey object.
 *
 * There is no `code`, no `errors[]`, and no `(code="…")` fragment in the text —
 * so `codesIn` finds nothing, `REASONS` cannot be consulted, and it fell all
 * the way to the generic sentence with an EMPTY reference under it. That is the
 * precise combination somebody reported: no system sheet, and no code to quote.
 *
 * ⚠ MATCHED ON THE MESSAGE, WHICH IS DISTASTEFUL AND IS THE ONLY HANDLE THERE
 * IS. The alternative is leaving the one failure we cannot otherwise name
 * indistinguishable from every unknown — and the string is clerk-js's own
 * `errorThrower` template, not a localised or user-facing one, so it does not
 * move when copy does.
 */
const MISSING_CHALLENGE = /missing\s+publickey/i

/**
 * ⚠ A SYNTHETIC CODE, AND IT IS MARKED AS OURS SO NOBODY GREPS CLERK FOR IT.
 * The reference line exists to be quoted back to us in a report; a blank one is
 * the failure mode this whole mechanism was built to prevent, so the uncoded
 * error is given a name rather than left without one.
 */
const NO_CHALLENGE_REFERENCE = "i10_passkey_no_challenge"

function missingChallenge(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.message === "string" &&
    MISSING_CHALLENGE.test(error.message)
  )
}

/** Every code this error mentions, wherever Clerk happened to put it. */
function codesIn(error: unknown): string[] {
  if (!error || typeof error !== "object") return []
  const found: string[] = []

  const { code, errors, message } = error as {
    code?: unknown
    errors?: unknown
    message?: unknown
  }

  if (typeof code === "string") found.push(code)

  // API failures keep their real codes in `errors[]` — see _lib/errors.ts,
  // where the same shape cost us the entire identifier-first flow.
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const nested = (entry as { code?: unknown })?.code
      if (typeof nested === "string") found.push(nested)
    }
  }

  // The re-wrapped ones. See the note at the top: this is a fragment of a
  // formatted message, not a field, and it is the only copy of the truth.
  if (typeof message === "string") {
    for (const match of message.matchAll(/\(code="([a-z_]+)"\)/g)) {
      if (match[1]) found.push(match[1])
    }
  }

  return found
}

/**
 * ⚠ THE UNWRAPPED EXCEPTION IS STILL POSSIBLE, so its names are mapped too. The
 * conditional-mediation call in the sign-in form talks to `navigator.credentials`
 * through Clerk, but an abort raised by the browser before Clerk sees it — a
 * page navigating away mid-prompt is the common one — arrives here as the
 * `DOMException` itself.
 */
const FROM_DOM: Record<string, string> = {
  NotAllowedError: "passkey_retrieval_cancelled",
  AbortError: "passkey_operation_aborted",
  InvalidStateError: "passkey_already_exists",
  SecurityError: "passkey_invalid_rpID_or_domain",
  NotSupportedError: "passkey_not_supported",
}

/** Everything this error calls itself, from every place Clerk might have put it. */
function allCodes(error: unknown): string[] {
  const codes = codesIn(error)
  const domName = error instanceof Error ? FROM_DOM[error.name] : undefined
  if (domName) codes.push(domName)
  return codes
}

/**
 * The short string to put under a message somebody is going to report to us.
 *
 * ⚠ IT EXISTS BECAUSE THE SENTENCE ALONE MADE THE NEXT BUG REPORT UNANSWERABLE.
 * "We could not add a passkey on this device" is the right thing to SAY and
 * carries nothing at all to act on: Clerk has nine of these codes, they arrive
 * through three different fields, and some of them are not WebAuthn codes but
 * API ones from `POST /v1/me/passkeys`. Reading it back was a round trip
 * through a person, a browser and a device we do not have.
 *
 * ⚠ IT IS THE SAME TRADE AS THE CLOUDFLARE RAY ID, and the same shape: when a
 * failure is somebody else's to diagnose, the one useful thing an interface can
 * do is carry the identifier they will ask for. It is a code, not a stack trace
 * and not Clerk's developer sentence — `passkey_registration_failed` is a fact,
 * `Clerk: The operation either timed out or was not allowed. See:
 * https://www.w3.org/TR/webauthn-2/…` is somebody else's debugging output
 * printed at a customer.
 *
 * ⚠ AND A CANCELLATION HAS NO REFERENCE, because a cancellation has no message
 * to attach one to. `passkeyFailure` returns `null` there and nothing is shown.
 *
 * ⚠ BUT A FAILURE ALWAYS HAS ONE NOW, AND IT DID NOT BEFORE. An error carrying
 * no code at all — which is one real, reachable case, see `MISSING_CHALLENGE` —
 * used to return `undefined` here, so the toast that most needed a reference
 * was the single toast that shipped without one. The exception `name` is a
 * weaker handle than a Clerk code and it is enormously better than a blank
 * line: `SyntaxError` and `TypeError` are different bugs, and a report that
 * says which is a report that can be answered.
 */
export function passkeyReference(error: unknown): string | undefined {
  const codes = allCodes(error)
  if (codes.some((code) => CANCELLED.has(code))) return undefined

  // ⚠ A `passkey_*` CODE WINS OVER WHATEVER ELSE IS IN THE LIST. Clerk's API
  // errors arrive alongside generic form codes, and `form_param_unknown` next
  // to `passkey_registration_failed` is the less specific of the two.
  const specific = codes.find((code) => code.startsWith("passkey_"))

  /*
   * ⚠ `api_response_error` IS AN ENVELOPE, NOT AN ANSWER, AND IT SORTS FIRST.
   * `ClerkAPIResponseError`'s constructor hardcodes it as the `code` of EVERY
   * error it wraps, while the code that means something sits in `errors[]` — so
   * `codes[0]` is the envelope and `codes[1]` is the fact. A real 403 from
   * `POST /v1/me/passkeys` would have printed `api_response_error` under the
   * toast, which is true of a rate limit, a bad parameter and a step-up policy
   * alike, and so tells whoever reads the report nothing at all.
   */
  const meaningful = codes.find((code) => code !== "api_response_error")
  const best = specific ?? meaningful ?? codes[0]
  if (best) return best

  if (missingChallenge(error)) return NO_CHALLENGE_REFERENCE
  return error instanceof Error && error.name ? error.name : undefined
}

/**
 * What to show somebody, or `null` if the honest answer is nothing.
 *
 * @param intent Which half of the product asked — the fallback sentence
 *   differs, because "we could not add one" and "that passkey did not work"
 *   send people to different places.
 */
export function passkeyFailure(error: unknown, intent: "add" | "use"): string | null {
  const codes = allCodes(error)

  // ⚠ CANCELLATION WINS OVER EVERYTHING ELSE IN THE LIST, because the list is
  // frequently `["passkey_retrieval_failed", "passkey_retrieval_cancelled"]` —
  // a generic wrapper around the real answer. Taking the first code would
  // report the wrapper.
  if (codes.some((code) => CANCELLED.has(code))) return null

  for (const code of codes) {
    const reason = REASONS[code]
    if (reason) return reason
  }

  // ⚠ CHECKED AFTER THE CODES AND BEFORE THE FALLBACK, WHICH IS THE ONLY PLACE
  // IT CAN GO. It is a message match, so anything that named itself properly
  // outranks it; and it has to come before the fallback, because the fallback
  // is exactly what was wrong with it. Both intents get the same sentence:
  // neither flow got as far as the device, so neither may mention it.
  if (missingChallenge(error)) return OURS

  return intent === "add"
    ? "We could not add a passkey on this device. You can add one later from settings."
    : "That passkey did not work. Try another way in."
}
