import type { Metadata } from "next"
import { afterAuthUrl } from "../../_lib/redirect"
import { TasksPanel } from "./tasks-panel"

export const metadata: Metadata = { title: "One more step · i10" }

/**
 * ⚠ NEVER PRERENDERED, for the same reason as the sign-in page: where this
 * sends somebody afterwards comes from the query string.
 */
export const dynamic = "force-dynamic"

/**
 * Clerk's session tasks — the step between "signed in" and "allowed in".
 *
 * ⚠ THIS ROUTE WAS MISSING, AND ITS ABSENCE LOCKED PEOPLE OUT OF THE PRODUCT.
 * Clerk v7 can hold a session at `status: "pending"` when the user still owes
 * it something — choosing an organization, resetting an expired password,
 * enrolling in MFA. `@clerk/backend` handles that by redirecting to
 * `${CLERK_SIGN_IN_URL}/tasks`, unconditionally and with no way to opt out:
 *
 *     const redirectToTasks = (url, { returnBackUrl }) =>
 *       redirectAdapter(buildUrl(baseUrl, `${url}/tasks`, …))
 *
 * We set `CLERK_SIGN_IN_URL` to our own sign-in page and never built the `tasks`
 * child, so every pending session landed on a 404 — signed in, unable to
 * continue, and unable to go back, because the middleware bounces them straight
 * here again. It is not a local-only problem: the same redirect happens in
 * production for anybody Clerk raises a task for.
 *
 * ⚠ AND THE TASK UIs ARE CLERK'S OWN COMPONENTS RATHER THAN HAND-BUILT. That is
 * the same division as the rest of this app — identity is Clerk's job here, and
 * `TaskChooseOrganization` in particular would otherwise mean rebuilding
 * organization creation, invitation acceptance and membership selection against
 * an API whose states we do not control. They inherit our palette from the
 * provider's `appearance`, so they do not arrive wearing Clerk's.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>
}) {
  const { redirect_url: raw } = await searchParams

  // ⚠ THE SAME ALLOWLIST AS EVERY OTHER DOOR. Clerk puts the original
  // destination in `redirect_url` when it bounces somebody here, which makes it
  // attacker-controllable exactly like the one on /sign-in — see _lib/redirect.
  const after = afterAuthUrl(raw)

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <TasksPanel afterAuthUrl={after} />
      </div>
    </main>
  )
}
