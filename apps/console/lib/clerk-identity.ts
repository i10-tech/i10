import { auth, clerkClient, currentUser } from "@clerk/nextjs/server"
import type { InitialUser } from "@/components/account-bar"

/**
 * Who is signed in and the active workspace's picture, read from Clerk on the
 * server, so the shell's first paint already shows them.
 *
 * ⚠ ONLY FOR THE FIRST PAINT (2026-11-04). The rail used to open on a name made
 * from the email and on letters for both pictures, and swap to the real ones
 * once Clerk's browser library loaded - the fallback shown before anything had
 * been tried. Once that library loads it owns these values again; this only
 * fills the moment before.
 *
 * ⚠ AND A FAILURE HERE IS NEVER AN ERROR. Each read falls back to null, and
 * null brings back the old behaviour: the email-made name and the letters,
 * which are then the honest answer to "we could not read it".
 */
/**
 * One more try, then null. On 2026-11-04 Clerk's server reads from the local
 * console failed with "fetch failed" on most full loads while the Cloudflare
 * tunnel was down, and succeeded on every load once it was back. One retry
 * rides out a blip like that; a real outage still ends in the fallback.
 */
async function once<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return read().catch(() => null)
  }
}

export async function clerkIdentity(): Promise<{
  user: InitialUser | null
  workspaceImage: string | null
}> {
  if (!process.env.CLERK_PUBLISHABLE_KEY) return { user: null, workspaceImage: null }
  const { orgId } = await auth()
  const [person, workspace] = await Promise.all([
    once(() => currentUser()),
    orgId
      ? once(async () =>
          (await clerkClient()).organizations.getOrganization({
            organizationId: orgId,
          }),
        )
      : null,
  ])
  return {
    user: person
      ? {
          firstName: person.firstName,
          username: person.username,
          email: person.primaryEmailAddress?.emailAddress ?? null,
          imageUrl: person.imageUrl,
        }
      : null,
    workspaceImage: workspace?.imageUrl ?? null,
  }
}
