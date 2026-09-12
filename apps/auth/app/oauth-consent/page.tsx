import type { Metadata } from "next"
import { ConsentForm } from "./consent-form"

export const metadata: Metadata = {
  title: "Authorize · i10",
  // ⚠ NOT INDEXABLE, for the same reason as the sign-in page — and more so.
  // This URL carries somebody's live authorization request in its query string.
  robots: { index: false, follow: false },
}

/** The whole page is a function of the query string. */
export const dynamic = "force-dynamic"

/**
 * Where Clerk sends somebody to approve a third-party app's access to their i10
 * account.
 *
 * ⚠ THIS IS i10 ACTING AS AN OAUTH *PROVIDER*, WHICH IS THE OPPOSITE DIRECTION
 * FROM THE REST OF THIS APP. Everywhere else here, i10 is the client and Google
 * or GitHub is the provider. Here some other application is the client and i10
 * is the identity — so nothing on this page has anything to do with the SSO
 * buttons on /sign-in, and the two must not be reasoned about together.
 *
 * ⚠ IT IS POINTED AT BY A CLERK DASHBOARD SETTING, NOT BY A LINK IN THIS APP.
 * "OAuth consent" under Paths has to name this URL, or Clerk serves its own
 * Account Portal version and the person sees a page we did not build in the
 * middle of granting access to their account. Nothing in this repo will fail if
 * that setting is wrong; it simply will not be used.
 *
 * ⚠ AND IT MUST STAY PUBLIC IN middleware.ts. Protecting it would send an
 * unauthenticated visitor to /sign-in with `?redirect_url=` pointing back here
 * — which the allowlist in _lib/redirect.ts rejects, because this app's own
 * origin is not a permitted destination. The signed-out case is handled in the
 * form instead, where it can keep the authorization request intact.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams

  /*
   * ⚠ EVERY PARAMETER IS CARRIED THROUGH, NOT JUST THE ONES WE READ. The form
   * re-emits all of them as hidden inputs, because the authorization request
   * belongs to Clerk and we are only the screen in the middle of it: `state` is
   * the client's CSRF token, `code_challenge` is its PKCE binding, and dropping
   * either silently turns a secure flow into a broken or weakened one. We must
   * forward parameters we do not understand, and that includes ones added to
   * the protocol after this file was written.
   *
   * ⚠ REPEATS ARE PRESERVED. `?scope=a&scope=b` is legal, and flattening it to
   * one value would quietly narrow what the person is consenting to.
   */
  const forwarded: [string, string][] = []
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) forwarded.push([key, item])
    } else if (typeof value === "string") {
      forwarded.push([key, value])
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <ConsentForm
          clientId={single(params.client_id)}
          scope={single(params.scope)}
          redirectUri={single(params.redirect_uri)}
          forwarded={forwarded}
        />
      </div>
    </main>
  )
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
