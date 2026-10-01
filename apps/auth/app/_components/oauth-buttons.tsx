"use client"

import { useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"
import { useClerk } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"

import { Spinner } from "@repo/ui/components/spinner"
import { TRANSPORT_FAILURE } from "../_lib/errors"
import type { SsoStrategy } from "../_lib/clerk-types"
import type { SsoProvider } from "../_lib/providers"
import { consentPromptFor } from "../_lib/oidc"
import { markSignInAttempt } from "../_lib/last-used"
import { LastUsedBadge } from "./last-used-badge"
import { AppleIcon, GitHubIcon, GoogleIcon } from "./provider-icons"

/**
 * The SSO buttons, on both pages.
 *
 * ⚠ IT STARTS A *SIGN-IN* EVEN ON THE SIGN-UP PAGE, AND THAT IS CORRECT RATHER
 * THAN A COPY-PASTE SLIP. An SSO redirect is one round trip that Clerk resolves
 * into whichever it turns out to be: a returning Google account completes a
 * sign-in, a new one is transferred into a sign-up. Starting a sign-UP flow
 * instead would make an existing customer who clicks "Sign up with Google" fail
 * with "that account already exists" rather than simply being let in.
 *
 * ⚠ IT DOES NOT CALL `signIn.sso()`, AND THAT IS THE FIX FOR BUTTONS THAT DID
 * NOTHING NINE TIMES OUT OF TEN. `sso()` in clerk-js 6.31.0 makes its own
 * `create` CONDITIONAL:
 *
 *     const hasUrl = !!signIn.firstFactorVerification.externalVerificationRedirectURL
 *     if (!signIn.id || hasUrl) await this._create({ strategy, ... })
 *     if (status === "unverified" && externalVerificationRedirectURL) navigate(…)
 *
 * With an attempt already in flight and no redirect URL on it, that skips the
 * create, finds nothing to navigate to, and resolves `{ error: null }` having
 * done nothing at all. And /sign-in creates exactly that attempt on mount - the
 * passkey autofill effect POSTs `strategy=passkey`, whose verification carries
 * no redirect URL. The attempt lives on the Clerk CLIENT, in the `__client`
 * cookie, so it follows the person to /sign-up and survives reloads.
 *
 * ⚠ PRIMING THE ATTEMPT FIRST AND THEN CALLING `sso()` WAS TRIED, AND IT FAILED
 * FOR A SECOND REASON WORTH RECORDING. `create()` REPLACES `clerk.client.signIn`
 * with a fresh resource, while `sso()` operates on the one captured when the
 * hook handed it to us - so the priming landed on one object and the call read
 * another, still unprimed. Measured live: one `POST /v1/client/sign_ins`, then
 * silence.
 *
 * So this does directly what `sso()` does internally, minus the conditional:
 * create the attempt with the provider strategy, then go to the URL that comes
 * back. One request, no second object to get stale, nothing to skip.
 */
export const LOCAL_ICONS: Record<
  string,
  (props: React.ComponentProps<"svg">) => React.ReactNode
> = {
  oauth_google: GoogleIcon,
  oauth_github: GitHubIcon,
  oauth_apple: AppleIcon,
}

/**
 * How long to wait for the browser to actually leave for the provider.
 *
 * ⚠ THIS EXISTS BECAUSE THE OLD CODE COULD DEAD-END THE WHOLE PAGE. `sso()`
 * resolving with no error was taken to mean "we are navigating", so nothing
 * ever released the lock - and when the hand-off did not happen (a blocked
 * navigation, a provider that never answered) every button on the page stayed
 * disabled with no message, which is the "the OAuth buttons just don't work"
 * report. The timer is long enough that it never fires during a real hand-off,
 * and `pagehide` cancels it the moment one starts.
 */
const HANDOFF_TIMEOUT_MS = 15_000

/**
 * Start an SSO sign-in: the provider buttons, and a saved account card that
 * last signed in with that provider, both go through here.
 *
 * ⚠ ONE COPY OF THE HANDOFF LOGIC, NOT TWO. The timeout, the bfcache restore
 * and the redirect all have their own reasons (see the notes on each); a card
 * that started Google its own way would be a second implementation of all of
 * them waiting to drift.
 */
export function useSsoStart({
  afterAuthUrl,
  redirectRaw,
  intent,
  busy,
  onBusyChange,
}: {
  afterAuthUrl: string
  redirectRaw?: string
  intent: "sign-in" | "sign-up"
  busy: string | null
  onBusyChange: (busy: string | null) => void
}) {
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
     * from the back/forward cache exactly as it was - including a `busy` that
     * has every button greyed out - so someone who thought better of Google and
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
    // ⚠ `clerk.loaded` IS THE READINESS GATE. Before it, `clerk.client` is not
    // there to create an attempt on, and a click is a dead button rather than a
    // slow one.
    if (!clerk.loaded || busy) return
    onBusyChange(strategy)

    /*
     * ⚠ AN ATTEMPT, NOT A RESULT. This is the last moment before the browser
     * leaves for the provider, so it is the only place the intention can be
     * recorded - but it is written to the PENDING slot and is promoted to "last
     * used" only when a session actually exists. Somebody who backs out of
     * Google's consent screen and then signs in with a password must not be
     * told next time that Google is what they used. See _lib/last-used.ts.
     */
    markSignInAttempt(strategy)

    handoff.current = window.setTimeout(() => {
      handoff.current = null
      onBusyChange(null)
      toast.error("That did not start. Try again.")
    }, HANDOFF_TIMEOUT_MS)

    try {
      /*
       * ⚠ TWO DIFFERENT URLS, AND SWAPPING THEM BREAKS THE FLOW SILENTLY.
       * `redirectUrl` here is OUR callback page, where the provider returns and
       * where `finalize()` actually creates the session.
       * `actionCompleteRedirectUrl` is where the person ends up afterwards.
       * Point the callback at the dashboard and the handshake is never finished
       * - the browser lands on an app that has no session and bounces straight
       * back to sign-in.
       *
       * ⚠ `buildUrlWithAuth` IS WHAT `sso()` APPLIES TO THE CALLBACK, so it is
       * applied here too. In production it returns the URL unchanged; in
       * development it carries the dev-browser token that lets the callback be
       * recognised at all. Dropping it would work in prod and break locally,
       * which is the worst way round.
       */
      await clerk.client.signIn.create({
        strategy,
        redirectUrl: clerk.buildUrlWithAuth(callbackUrl(redirectRaw)),
        actionCompleteRedirectUrl: afterAuthUrl,
        /*
         * ⚠ WITHOUT THIS, A PROVIDER ACCOUNT THAT HAS NEVER SIGNED IN HERE IS
         * SIMPLY REFUSED. We always start a sign-IN - correctly, because one
         * SSO round trip resolves into whichever it turns out to be - but a
         * sign-in with no matching user has nowhere to go unless it is told it
         * may become a sign-up. Google answered that with a hard
         * `authorization_invalid` from FAPI, before the browser ever got back
         * to us; GitHub came back `transferable` and died in the callback.
         *
         * ⚠ IT IS WHY /sign-in NOW RENDERS `#clerk-captcha` TOO. Clerk's own
         * note on this flag: "If bot sign-up protection is enabled, captcha
         * will also be required on sign in." A sign-in that may create an
         * account is a sign-up as far as bot protection is concerned, and with
         * nowhere to mount its widget the attempt is rejected rather than
         * challenged.
         */
        signUpIfMissing: true,
        /*
         * Undefined unless this is a sign-up with a provider that needs it,
         * which Clerk then omits from the authorize URL - so the ordinary
         * sign-in path is untouched.
         */
        oidcPrompt: consentPromptFor(strategy, intent),
      })

      /*
       * ⚠ RE-READ FROM THE CLIENT, NOT FROM A VALUE CAPTURED BEFORE THE CALL.
       * `create()` replaces `clerk.client.signIn`, which is the whole reason
       * the previous attempt at this bug failed - see the note at the top.
       */
      const verification = clerk.client.signIn.firstFactorVerification
      const target = verification?.externalVerificationRedirectURL

      if (verification?.status === "unverified" && target) {
        /*
         * ⚠ `assign`, NOT `replace`, AND NOT AN `href` ASSIGNMENT. Assign keeps
         * this page in history, so backing out of the provider's consent screen
         * returns here rather than skipping past - the `pageshow` handler above
         * is what unfreezes the buttons when that happens. It is a method call
         * rather than `location.href = …` because the React Compiler lint rule
         * `react-hooks/immutability` rejects writing to a value defined outside
         * the component, and it is right to: the assignment form reads like
         * state mutation.
         *
         * ⚠ AND THE LOCK IS NOT RELEASED. The browser is leaving, and
         * re-enabling the row for the second that takes invites a second click
         * that starts a second flow against the same client.
         */
        window.location.assign(String(target))
        return
      }

      // Clerk accepted the attempt but produced nowhere to send anybody. There
      // is nothing to retry silently, so say so rather than sit disabled.
      clearHandoff()
      onBusyChange(null)
      toast.error("That did not start. Try again.")
    } catch (error) {
      clearHandoff()
      onBusyChange(null)
      toast.error(clerkErrorMessage(error))
    }
  }

  return { start, ready: clerk.loaded }
}

export function OAuthButtons({
  afterAuthUrl,
  redirectRaw,
  verb,
  intent,
  providers,
  busy,
  onBusyChange,
  lastUsed = null,
}: {
  afterAuthUrl: string
  redirectRaw?: string
  /** "Continue" reads right on both pages; the prop exists so it need not. */
  verb?: string
  intent: "sign-in" | "sign-up"
  providers: SsoProvider[]
  /** The id of the one action allowed to be running, or null. */
  busy: string | null
  onBusyChange: (busy: string | null) => void
  /**
   * The strategy to mark "Last used", or null. Decided by the sign-in form,
   * which is the only place that can see whether a saved account already
   * carries the chip - see _components/last-used-badge.tsx.
   */
  lastUsed?: string | null
}) {
  const { start, ready } = useSsoStart({
    afterAuthUrl,
    redirectRaw,
    intent,
    busy,
    onBusyChange,
  })

  if (providers.length === 0) return null

  /*
   * ⚠ A FRAGMENT RATHER THAN A `<Field>`, AND THE CALLER OWNS THE GROUP NOW.
   * This used to wrap itself, which meant the passkey button added beside it had
   * to sit in a SECOND Field - 28px of `FieldGroup` gap between two stacks of
   * identical-looking buttons, where the buttons within each stack are 12px
   * apart. They are all "continue without typing a password" and they should
   * read as one list.
   *
   * ⚠ IT ALSO FIXES A LATENT EMPTY SEPARATOR. With no providers configured this
   * returns null, and the "Or continue with" rule above it used to be left
   * pointing at nothing. The caller's Field still holds the passkey button, so
   * there is always something under the rule.
   */
  return (
    <>
      {providers.map(({ strategy, name }) => {
        const loading = busy === strategy
        const Icon = LOCAL_ICONS[strategy]

        return (
          <Button
            key={strategy}
            variant="outline"
            size="xl"
            type="button"
            // ⚠ THE POSITIONING CONTEXT FOR THE "Last used" CHIP, which is
            // absolutely positioned on this button's top edge. Without it the
            // chip would anchor to whatever ancestor happens to be relative.
            className="relative"
            // ⚠ DISABLED UNTIL CLERK HAS LOADED. `signIn` is null until then,
            // and a click before that point is a dead button rather than a slow
            // one. `busy` covers the rest of the page, including the password
            // form.
            disabled={!ready || busy !== null}
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
            ) : Icon ? (
              <Icon aria-hidden="true" />
            ) : null}
            {loading
              ? `Continuing with ${name}…`
              : `${verb ?? "Continue"} with ${name}`}
            {/*
             * ⚠ ON THE SIGN-IN PAGE ONLY. "Last used" beside a button on the
             * SIGN-UP page is telling somebody who is creating an account about
             * an account they already have - which is either confusing or, if
             * they act on it, the thing the badge exists to prevent in reverse.
             */}
            {lastUsed === strategy && !loading && (
              <LastUsedBadge className="absolute end-4 top-1/2 -translate-y-1/2" />
            )}
          </Button>
        )
      })}
    </>
  )
}

/** Our own origin, plus the destination the person arrived with. */
function callbackUrl(redirectRaw: string | undefined): string {
  const url = new URL("/sso-callback", window.location.origin)
  if (redirectRaw) url.searchParams.set("redirect_url", redirectRaw)
  return url.toString()
}

/**
 * A sentence for something the classic resource threw.
 *
 * ⚠ THE CLASSIC API THROWS, WHERE THE SIGNALS API RETURNS `{ error }`. That
 * difference is why this exists alongside `_lib/errors.ts`: a handler written
 * for one shape reports nothing useful for the other. `longMessage` first, for
 * the same reason as there - Clerk documents `message` as developer-facing.
 */
function clerkErrorMessage(error: unknown): string {
  const errors = (error as { errors?: { longMessage?: string; message?: string }[] })
    ?.errors
  return errors?.[0]?.longMessage ?? errors?.[0]?.message ?? TRANSPORT_FAILURE
}
