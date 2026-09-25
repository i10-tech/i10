import type { Metadata } from "next"
import { headers } from "next/headers"
import { ssoProviders } from "../_lib/providers"
import { passwordRules, signUpAbilities } from "../_lib/environment"
import { afterAuthUrl } from "../_lib/redirect"
import { AuthFlow } from "../_components/auth-flow"
import { ResumeBoundary } from "../_components/resume-boundary"

export const metadata: Metadata = { title: "Sign in · i10" }

/**
 * The only door.
 *
 * ⚠ THERE IS NO SIGN-UP PAGE ANY MORE, AND THAT IS THE WHOLE CHANGE. Two pages
 * made somebody choose a door before we had told them which one was theirs —
 * a question only a lookup can answer. Answering it wrong was the failure in
 * both directions: a returning customer on the sign-up page told their address
 * was taken, a new one on the sign-in page told there was no such account.
 * `/sign-up` now redirects here, so the URL survives for anything that has it
 * bookmarked without there being a second implementation behind it.
 *
 * ⚠ THE PATH KEEPS ITS NAME BECAUSE CLERK POINTS AT IT. `display_config.sign_in_url`
 * on the production instance is `https://auth.i10.tech/sign-in`, so this is
 * where Clerk's own redirects land; renaming it to something neutral would add
 * a hop to the most common path in the product to make a URL read better.
 */
export const dynamic = "force-dynamic"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>
}) {
  const { redirect_url: raw } = await searchParams

  // ⚠ VALIDATED HERE, ON THE SERVER, AND HANDED DOWN AS A PLAIN STRING. See
  // _lib/redirect.ts: the parameter is attacker-controllable, and the allowlist
  // it is checked against is unprefixed runtime env a client component could
  // not read.
  const after = afterAuthUrl(raw)

  // Password reset and the two-factor step keep the destination the person
  // arrived with, so they still land where they were originally going.
  const carry =
    typeof raw === "string" ? `?redirect_url=${encodeURIComponent(raw)}` : ""

  /*
   * ⚠ ALL THREE READ THE SAME CLERK ENVIRONMENT DOCUMENT AND COST ONE REQUEST.
   * Next dedupes identical `fetch`es within a render pass — see
   * _lib/environment.ts, which owns the fetch and its cache.
   *
   * ⚠ AND THE SIGN-UP FACTS ARE FETCHED EVEN THOUGH MOST VISITS ARE SIGN-INS,
   * because an unknown address turns into a sign-up without a navigation. What
   * the instance can finish and what it accepts as a password have to be in
   * hand before the first paint; resolving them after the branch would give a
   * form that renders and then corrects its own password hint, which is the
   * exact bug `passwordRules` exists to prevent.
   */
  const [providers, abilities, password] = await Promise.all([
    ssoProviders((await headers()).get("user-agent")),
    signUpAbilities(),
    passwordRules(),
  ])

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        {/*
         * ⚠ RESUMED FROM THIS TAB'S OWN MEMORY, NOT FROM THE URL. This page used
         * to read `?step=connect` to re-enter sign-up after a provider round
         * trip; now every step of both flows survives a reload the same way,
         * and the address bar only ever says /sign-in. See _lib/resume.tsx.
         */}
        <ResumeBoundary>
          <AuthFlow
            afterAuthUrl={after}
            resetHref={`/reset-password${carry}`}
            mfaHref={`/mfa${carry}`}
            redirectRaw={typeof raw === "string" ? raw : undefined}
            providers={providers}
            abilities={abilities}
            password={password}
          />
        </ResumeBoundary>
      </div>
    </main>
  )
}
