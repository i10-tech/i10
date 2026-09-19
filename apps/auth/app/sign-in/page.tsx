import type { Metadata } from "next"
import { headers } from "next/headers"
import { ssoProviders } from "../_lib/providers"
import { passwordRules, signUpAbilities } from "../_lib/environment"
import { afterAuthUrl } from "../_lib/redirect"
import { AuthFlow } from "../_components/auth-flow"

export const metadata: Metadata = { title: "Sign in · i10" }

/**
 * ⚠ NEVER PRERENDERED. Where this page sends somebody afterwards is read from
 * the query string, so a statically generated shell would bake in one
 * destination and hand it to everybody.
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

  // Password reset keeps the destination the person arrived with, so it still
  // lands them where they were originally going rather than on a dashboard.
  // Signing up no longer needs a door: an unknown address opens it in place.
  const carry =
    typeof raw === "string" ? `?redirect_url=${encodeURIComponent(raw)}` : ""

  // ⚠ WHICH SSO BUTTONS EXIST IS CLERK'S ANSWER, NOT OURS, and it is
  // resolved here so the first paint is already correct. See
  // _lib/providers.ts — it also applies the Apple-hardware rule.
  /*
   * ⚠ THE SIGN-UP INSTANCE FACTS ARE FETCHED HERE TOO, BECAUSE THIS PAGE IS
   * BOTH DOORS NOW. An unknown address turns into a sign-up without a
   * navigation, so what the instance can finish and what it accepts as a
   * password have to be in hand before the first paint — resolving them after
   * the branch would mean a form that renders and then corrects its own
   * password hint, which is the exact bug `passwordRules` was added to fix.
   */
  const [providers, abilities, password] = await Promise.all([
    ssoProviders((await headers()).get("user-agent")),
    signUpAbilities(),
    passwordRules(),
  ])

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <AuthFlow
          afterAuthUrl={after}
          resetHref={`/reset-password${carry}`}
          mfaHref={`/mfa${carry}`}
          redirectRaw={typeof raw === "string" ? raw : undefined}
          providers={providers}
          abilities={abilities}
          password={password}
        />
      </div>
    </main>
  )
}
