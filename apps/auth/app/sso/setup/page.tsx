import type { Metadata } from "next"
import { SsoSetup } from "./sso-setup"

export const metadata: Metadata = {
  title: "Set up single sign-on · i10",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

/**
 * The page an IT contact opens from a setup link (#340, sso.md 2.10): they
 * have no i10 account, and the link lets them enter their identity provider's
 * settings and run a test, nothing more.
 *
 * ⚠ THE TOKEN IS A CREDENTIAL, AND IT ARRIVES IN THE ADDRESS. See
 * `[token]/page.tsx`: the client moves it out of the URL at once, and this
 * app sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on
 * both routes (next.config.ts).
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
