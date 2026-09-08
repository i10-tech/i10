"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field } from "@repo/ui/components/field"
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
 * ⚠ AND THE WHOLE SET IS DISABLED WHILE ONE IS IN FLIGHT. `sso` navigates the
 * browser away; until it actually leaves, the buttons are still live and a
 * second click starts a second flow whose state races the first.
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

export function OAuthButtons({
  afterAuthUrl,
  redirectRaw,
  verb,
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
}) {
  const { signIn } = useSignIn()
  const [pending, setPending] = useState<SsoStrategy | null>(null)

  async function start(strategy: SsoStrategy) {
    if (!signIn || pending) return
    setPending(strategy)

    try {
      const { error } = await signIn.sso({
        strategy,
        // ⚠ TWO DIFFERENT URLS, AND SWAPPING THEM BREAKS THE FLOW SILENTLY.
        // `redirectCallbackUrl` is OUR page, where the provider returns and
        // where `finalize()` actually creates the session. `redirectUrl` is
        // where the person ends up afterwards. Point the callback at the
        // dashboard and the handshake is never finished — the browser lands on
        // an app that has no session and bounces straight back to sign-in.
        redirectCallbackUrl: `/sso-callback${
          redirectRaw ? `?redirect_url=${encodeURIComponent(redirectRaw)}` : ""
        }`,
        redirectUrl: afterAuthUrl,
      })

      // Reached only when the redirect did not happen — otherwise the browser
      // has already left this page.
      if (error) {
        setPending(null)
        toast.error(messageFor(error))
      }
    } catch {
      setPending(null)
      toast.error(TRANSPORT_FAILURE)
    }
  }

  return (
    <Field>
      {PROVIDERS.map(({ strategy, label, Icon }) => (
        <Button
          key={strategy}
          variant="outline"
          type="button"
          // ⚠ DISABLED UNTIL CLERK HAS LOADED. `signIn` is null until then, and
          // a click before that point is a dead button rather than a slow one.
          disabled={!signIn || pending !== null}
          onClick={() => start(strategy)}
        >
          <Icon aria-hidden="true" />
          {verb ?? "Continue"} with {label}
        </Button>
      ))}
    </Field>
  )
}
