import type { Metadata } from "next"
import { afterAuthUrl } from "../../_lib/redirect"
import { SsoContinue } from "./sso-continue"

export const metadata: Metadata = { title: "Signing you in · i10" }

export const dynamic = "force-dynamic"

/**
 * Where an SSO sign-in comes back to once the IdP's answer is verified
 * (#337): `#code=<one-time code>`, or `#error=<message>`.
 *
 * ⚠ IN THE FRAGMENT, NOT THE QUERY. A fragment is never sent to a server, so
 * the code is in no access log, no proxy log and no `Referer`.
 */
export default function Page() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 pt-24 pb-12">
      <div className="w-full max-w-sm">
        <SsoContinue fallbackUrl={afterAuthUrl(undefined)} />
      </div>
    </main>
  )
}
