import { permanentRedirect } from "next/navigation"

/**
 * There is no sign-up page. This is the redirect that says so.
 *
 * ⚠ THE PAGE IT REPLACED WAS HALF OF A DECISION NOBODY SHOULD HAVE BEEN ASKED
 * TO MAKE. "Do you already have an account" is a lookup, and putting it to
 * somebody who has half-forgotten produced a dead end in either direction: a
 * returning customer here was told their address was taken, and a new one on
 * `/sign-in` was told there was no such account. Both were reached by answering
 * honestly. One box on one page answers it for them.
 *
 * ⚠ THE URL SURVIVES BECAUSE THINGS POINT AT IT. Clerk's `display_config`
 * carries `sign_up_url` for this instance, marketing links exist, and people
 * bookmark. A 404 for any of them would be a worse answer than a redirect.
 *
 * ⚠ EVERY QUERY PARAMETER IS CARRIED, WHICH IS NOT COSMETIC. `redirect_url` is
 * how somebody lands back where they were going, and `step` is how a browser
 * returning from a provider re-enters a half-finished flow — dropping either
 * turns a resumable journey into a restart. The parameters are forwarded
 * verbatim and validated by the page that receives them, which is the only
 * place that has the allowlist.
 *
 * ⚠ `permanentRedirect`, NOT `redirect`. A 308 lets browsers and crawlers stop
 * asking, which is true: this is not coming back. It also preserves the method,
 * though nothing here posts.
 */
export const dynamic = "force-dynamic"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value)
    // ⚠ A REPEATED PARAMETER KEEPS ONLY ITS FIRST VALUE, matching how the
    // receiving page reads it — it takes `typeof raw === "string"` and ignores
    // an array, so forwarding every copy would carry values it will discard.
    else if (Array.isArray(value) && value[0] !== undefined) query.set(key, value[0])
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : ""
  permanentRedirect(`/sign-in${suffix}`)
}
