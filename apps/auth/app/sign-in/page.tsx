import type { Metadata } from "next"
import { headers } from "next/headers"
import { isAppleUserAgent } from "../_lib/apple"
import { afterAuthUrl } from "../_lib/redirect"
import { SignInForm } from "./sign-in-form"

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

  // The other two doors, keeping the destination the person arrived with — so
  // signing up, or resetting a password, still lands them where they were
  // originally going rather than on a default dashboard.
  const carry =
    typeof raw === "string" ? `?redirect_url=${encodeURIComponent(raw)}` : ""

  // ⚠ "Continue with Apple" IS DECIDED HERE RATHER THAN IN THE BROWSER, so
  // the first paint is already right and no button appears a beat late,
  // shifting the ones under it. See _lib/apple.ts. This page is
  // `force-dynamic` already, so reading a header costs nothing.
  const showApple = isAppleUserAgent((await headers()).get("user-agent"))

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <SignInForm
          afterAuthUrl={after}
          signUpHref={`/sign-up${carry}`}
          resetHref={`/reset-password${carry}`}
          mfaHref={`/mfa${carry}`}
          passkeyHref={`/passkey${carry}`}
          redirectRaw={typeof raw === "string" ? raw : undefined}
          showApple={showApple}
        />
      </div>
    </main>
  )
}
