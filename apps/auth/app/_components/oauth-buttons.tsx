"use client"

import { useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"
import { useClerk, useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field } from "@repo/ui/components/field"
import { Spinner } from "@repo/ui/components/spinner"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import type { SsoStrategy } from "../_lib/clerk-types"
import { AppleIcon, GitHubIcon, GoogleIcon } from "./provider-icons"

/**
 * Google, GitHub and Apple, on both pages.
 *
 * ⚠ IT CALLS `signIn.sso` ON THE SIGN-UP PAGE TOO, AND THAT IS CORRECT RATHER
 * THAN A COPY-PASTE SLIP. An SSO redirect is one round trip that Clerk resolves
 * into whichever it turns out to be: a returning Google account completes a
 * sign-in, a new one is transferred into a sign-up. Wiring the sign-up page to
 * `signUp.sso` instead would make an existing customer who clicks "Sign up with
 * Google" fail with "that account already exists" rather than simply being let
 * in.
 *
 * ⚠ AND THE LOCK IS THE PAGE'S, NOT THIS COMPONENT'S. `busy` comes from the
 * form above so that ONE action can be in flight anywhere on the page: starting
 * Google and then submitting the password form used to be possible, and it
 * raced two flows against the same Clerk client — whichever finished second
 * either overwrote the first or failed against state it did not create. The
 * value is the id of whatever is running, so each button can tell "I am the one
 * loading" from "something else is".
 */

const PROVIDERS = [
  { strategy: "oauth_google", label: "Google", Icon: GoogleIcon },
  { strategy: "oauth_github", label: "GitHub", Icon: GitHubIcon },
  { strategy: "oauth_apple", label: "Apple", Icon: AppleIcon },
] as const satisfies readonly {
  strategy: SsoStrategy
  label: string
  Icon: (props: React.ComponentProps<"svg">) => React.ReactNode
}[]

/**
 * How long to wait for the browser to actually leave for the provider.
 *
 * ⚠ THIS EXISTS BECAUSE THE OLD CODE COULD DEAD-END THE WHOLE PAGE. `sso()`
 * resolving with no error was taken to mean "we are navigating", so nothing
 * ever released the lock — and when the hand-off did not happen (a blocked
 * navigation, a provider that never answered) every button on the page stayed
 * disabled with no message, which is the "the OAuth buttons just don't work"
 * report. The timer is long enough that it never fires during a real hand-off,
 * and `pagehide` cancels it the moment one starts.
 */
const HANDOFF_TIMEOUT_MS = 15_000

export function OAuthButtons({
  afterAuthUrl,
  redirectRaw,
  verb,
  showApple,
  busy,
  onBusyChange,
}: {
  afterAuthUrl: string
  /**
   * The ORIGINAL `?redirect_url=`, forwarded to the callback page rather than
   * the resolved destination — see sso-callback/page.tsx. A resolved URL
   * travelling through a provider's redirect is an unvalidated URL again.
   */
  redirectRaw?: string
  /** "Continue" reads right on both pages; the prop exists so it need not. */
  verb?: string
  /** Decided from the request's User-Agent — see _lib/apple.ts. */
  showApple: boolean
  /** The id of the one action allowed to be running, or null. */
  busy: string | null
  onBusyChange: (busy: string | null) => void
}) {
  const { signIn } = useSignIn()
  const clerk = useClerk()
  const handoff = useRef<number | null>(null)

  const clearHandoff = useCallback(() => {
    if (handoff.current === null) return
    window.clearTimeout(handoff.current)
    handoff.current = null
  }, [])

  useEffect(() => {
    /*
     * ⚠ `pagehide` CANCELS THE TIMER, and without it the timeout above becomes
     * a lie detector that fires on a slow connection. The browser keeps running
     * this document while it fetches the provider's page, so a hand-off that
     * takes sixteen seconds would show "that did not start" a heartbeat before
     * successfully leaving.
     */
    const leaving = () => clearHandoff()

    /*
     * ⚠ AND `pageshow` WITH `persisted` IS THE BACK BUTTON, which is the most
     * common way this flow ends without finishing. Safari restores the page
     * from the back/forward cache exactly as it was — including a `busy` that
     * has every button greyed out — so someone who thought better of Google and
     * came back found a page they could no longer use. Unfreezing on restore is
     * the whole fix.
     */
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      clearHandoff()
      onBusyChange(null)
    }

    window.addEventListener("pagehide", leaving)
    window.addEventListener("pageshow", restored)
    return () => {
      window.removeEventListener("pagehide", leaving)
      window.removeEventListener("pageshow", restored)
      clearHandoff()
    }
  }, [clearHandoff, onBusyChange])

  async function start(strategy: SsoStrategy) {
    if (!signIn || busy) return
    onBusyChange(strategy)

    handoff.current = window.setTimeout(() => {
      handoff.current = null
      onBusyChange(null)
      toast.error("That did not start. Try again.")
    }, HANDOFF_TIMEOUT_MS)

    try {
      await primeAttempt(clerk, strategy, redirectRaw, afterAuthUrl)

      const { error } = await signIn.sso({
        strategy,
        /*
         * ⚠ TWO DIFFERENT URLS, AND SWAPPING THEM BREAKS THE FLOW SILENTLY.
         * `redirectCallbackUrl` is OUR page, where the provider returns and
         * where `finalize()` actually creates the session. `redirectUrl` is
         * where the person ends up afterwards. Point the callback at the
         * dashboard and the handshake is never finished — the browser lands on
         * an app that has no session and bounces straight back to sign-in.
         *
         * ⚠ THE CALLBACK IS ABSOLUTE, AND THIS IS TIDINESS RATHER THAN THE BUG
         * FIX IT WAS FIRST ASSUMED TO BE. Measured against clerk-js 6.31.0, a
         * relative `/sso-callback` behaved identically — so this was NOT the
         * cause of the buttons failing; see `primeAttempt` below for what
         * actually was. It stays absolute because the SDK treats the two
         * parameters differently: `actionCompleteRedirectUrl` is explicitly
         * origin-prefixed when it fails to parse, while this one is passed
         * straight to `buildUrlWithAuth` with no such handling. Giving it a
         * whole URL means not depending on that asymmetry holding.
         */
        redirectCallbackUrl: callbackUrl(redirectRaw),
        redirectUrl: afterAuthUrl,
      })

      // Reached only when the redirect did not happen — otherwise the browser
      // has already left this page.
      if (error) {
        clearHandoff()
        onBusyChange(null)
        toast.error(messageFor(error))
      }
    } catch {
      clearHandoff()
      onBusyChange(null)
      toast.error(TRANSPORT_FAILURE)
    }
  }

  const providers = showApple
    ? PROVIDERS
    : PROVIDERS.filter(({ strategy }) => strategy !== "oauth_apple")

  return (
    <Field>
      {providers.map(({ strategy, label, Icon }) => {
        const loading = busy === strategy

        return (
          <Button
            key={strategy}
            variant="outline"
            type="button"
            // ⚠ DISABLED UNTIL CLERK HAS LOADED. `signIn` is null until then,
            // and a click before that point is a dead button rather than a slow
            // one. `busy` covers the rest of the page, including the password
            // form.
            disabled={!signIn || busy !== null}
            onClick={() => start(strategy)}
          >
            {/*
             * ⚠ THE MARK IS REPLACED BY THE SPINNER RATHER THAN JOINED BY IT.
             * Two icons in one button is a wider button, and a row of provider
             * buttons that changes width when one is pressed moves the other
             * two under the pointer.
             */}
            {loading ? (
              <Spinner aria-hidden="true" aria-label={undefined} />
            ) : (
              <Icon aria-hidden="true" />
            )}
            {loading
              ? `Continuing with ${label}…`
              : `${verb ?? "Continue"} with ${label}`}
          </Button>
        )
      })}
    </Field>
  )
}

/** Our own origin, plus the destination the person arrived with. */
function callbackUrl(redirectRaw: string | undefined): string {
  const url = new URL("/sso-callback", window.location.origin)
  if (redirectRaw) url.searchParams.set("redirect_url", redirectRaw)
  return url.toString()
}

/**
 * Make sure `sso()` will actually do something.
 *
 * ⚠ THIS IS A WORKAROUND FOR A BUG IN clerk-js, AND WITHOUT IT THE OAUTH
 * BUTTONS SILENTLY DO NOTHING FOR MOST PEOPLE, MOST OF THE TIME. Read the
 * shipped implementation of `SignIn.sso` (clerk-js 6.31.0) and the shape of it
 * is:
 *
 *     const hasUrl = !!signIn.firstFactorVerification.externalVerificationRedirectURL
 *     if (!signIn.id || hasUrl) await this._create({ strategy, ... })
 *     const { status, externalVerificationRedirectURL } = signIn.firstFactorVerification
 *     if (status === "unverified" && externalVerificationRedirectURL) navigate(…)
 *
 * The create is CONDITIONAL. If a sign-in attempt already exists and it carries
 * no external redirect URL, `sso()` skips the create, finds no URL to go to,
 * and resolves `{ error: null }` having done absolutely nothing. Success, no
 * navigation, no request, nothing to show the person.
 *
 * ⚠ AND OUR SIGN-IN PAGE CREATES EXACTLY THAT ATTEMPT ON MOUNT. The passkey
 * conditional-mediation effect POSTs `strategy=passkey`, which produces an
 * attempt whose verification is a passkey challenge — status `unverified`, no
 * `externalVerificationRedirectURL`. From that moment every provider button is
 * dead. It is not even scoped to the page: the attempt lives on the Clerk
 * CLIENT, in the `__client` cookie, so it follows the person to /sign-up and
 * survives reloads until it expires. That is the whole of "the OAuth buttons
 * work sometimes" — they work in a browser that has not yet loaded the sign-in
 * page, and stop for a day afterwards.
 *
 * ⚠ THE FIX IS TO GIVE THE ATTEMPT A REDIRECT URL, WHICH FLIPS `hasUrl` TRUE
 * AND MAKES `sso()` RE-CREATE. `create()` on the classic resource is the same
 * underlying SignIn object the signals API wraps, so this is not two competing
 * flows — it is one attempt, primed. `sso()` is still what navigates, which
 * keeps `buildUrlWithAuth`, popup handling and everything else the SDK's job
 * rather than ours.
 *
 * ⚠ IT ONLY FIRES WHEN THE ATTEMPT IS ACTUALLY POISONED, so the common path
 * costs nothing. And it swallows its own failure on purpose: if the priming
 * call fails, `sso()` is still worth attempting, and its error is the one worth
 * showing.
 *
 * Remove this the moment clerk-js makes that create unconditional.
 */
async function primeAttempt(
  clerk: ReturnType<typeof useClerk>,
  strategy: SsoStrategy,
  redirectRaw: string | undefined,
  afterAuthUrl: string,
): Promise<void> {
  const attempt = clerk.client?.signIn
  if (!attempt?.id) return
  if (attempt.firstFactorVerification?.externalVerificationRedirectURL) return

  try {
    await attempt.create({
      strategy,
      redirectUrl: callbackUrl(redirectRaw),
      actionCompleteRedirectUrl: afterAuthUrl,
    })
  } catch {
    // Deliberately ignored — see above.
  }
}
