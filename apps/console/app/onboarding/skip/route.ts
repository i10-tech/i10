import { redirect } from "next/navigation"
import { rememberOnboardingSkip } from "@/lib/onboarding-skip"
import { tryApi } from "@/lib/api"
import type { Me } from "@/lib/types"

/**
 * Where "Skip to the console" actually goes.
 *
 * ⚠ A ROUTE RATHER THAN A `<Link href="/">`, BECAUSE THE LINK WAS THE BUG. The
 * console layout redirects to `/onboarding` while `should_onboard` is true, so
 * a plain link to `/` bounced the person straight back into the flow they had
 * just asked to leave. Something has to be written down between the click and
 * the console, and this is the smallest place to write it.
 *
 * ⚠ GET IS CORRECT HERE DESPITE WRITING A COOKIE. What it stores is this
 * browser's own view preference, not account state — nothing about the
 * workspace, the plan or the domains changes — so there is no cross-site
 * request worth forging, and `SameSite=Lax` already bounds it. Making it a POST
 * would cost a form and a client component for a link in a header.
 */
/**
 * Where the browser is sent afterwards.
 *
 * ⚠ A PATH ON THIS CONSOLE, NEVER A URL, AND THIS FUNCTION IS THE WHOLE OF THAT
 * GUARANTEE. The destination arrives in a query parameter, so without it this
 * route is an open redirect that any page can link to — and one that sets a
 * cookie on the way, which is exactly the shape somebody looks for.
 *
 * ⚠ A LEADING `//` OR `/\` IS REFUSED, because both are protocol-relative URLs
 * once a browser normalises them: `//evil.example` is not a path on this site,
 * it is `https://evil.example`. The same rule the API applies to the OAuth
 * `return_to` — see `safeReturnTo` in dns/oauth.ts.
 */
function safeDestination(value: string | null): string {
  if (!value || !value.startsWith("/")) return "/"
  if (/^\/[/\\]/.test(value)) return "/"
  return value
}

export async function GET(request: Request) {
  /*
   * ⚠ THE WORKSPACE IS READ HERE RATHER THAN ASSUMED, because the cookie is
   * keyed to it — see lib/onboarding-skip.ts for the bug that keying fixes. It
   * costs one call on a click somebody makes at most once per workspace.
   *
   * ⚠ AND A FAILURE STILL LETS THEM THROUGH. If `/console/me` is unreachable,
   * refusing to skip would trap somebody in a flow they asked to leave because
   * of an error that has nothing to do with them. They land on the console and
   * the layout decides again with fresh information.
   */
  const me = await tryApi<Me>("/console/me")
  if (me.ok && me.data.tenant) await rememberOnboardingSkip(me.data.tenant.id)

  /*
   * ⚠ `?to=` EXISTS BECAUSE "Records" WAS THE SAME BUG AS "Skip" HAD BEEN. That
   * button is a plain link to `/domains/<id>`, which lives under the console
   * layout — so the gate bounced it straight back to `/onboarding` and the
   * click did nothing at all. Anything that leaves the flow has to come through
   * here, because here is where the leaving is written down.
   */
  redirect(safeDestination(new URL(request.url).searchParams.get("to")))
}
