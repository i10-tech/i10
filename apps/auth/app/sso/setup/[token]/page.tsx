import type { Metadata } from "next"
import { SsoSetup } from "../sso-setup"

export const metadata: Metadata = {
  title: "Set up single sign-on · i10",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

/**
 * `/sso/setup/<token>`: the setup link itself.
 *
 * ⚠ THE `params` ARE DELIBERATELY NEVER READ. This render must not depend on
 * the token, so it appears in no server-side render output; the browser reads
 * it from `location.pathname`, keeps it in sessionStorage, and replaces the
 * address with `/sso/setup` before anything else happens (`takeToken`). The
 * request itself still carried it once, as any link does - which is why the
 * API says the token sits in the path, and why it is single-purpose, expires,
 * and is revocable.
 */
export default function Page() {
  return (
    <main className="flex min-h-dvh justify-center px-6 pt-24 pb-12">
      <div className="w-full max-w-lg">
        <SsoSetup />
      </div>
    </main>
  )
}
