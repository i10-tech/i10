"use server"

import { auth, clerkClient } from "@clerk/nextjs/server"

/**
 * The Clerk org-component probe's one server action: make (or find) a Clerk
 * organization that exists only to study Clerk's own self-serve SSO and
 * directory sync, with the signed-in person as its Clerk admin.
 *
 * ⚠ DEV INSTANCE ONLY, TWICE OVER. A production build folds the first check to
 * a throw, and a live key is refused, so this can never touch the production
 * instance (where "no Clerk enterprise connections", sso.md, is a hard rule).
 *
 * ⚠ OUR ROLES WEBHOOK DEMOTES THE ADMIN AGAIN while the dev tunnel is up
 * (roles.ts `fixClerkRole`). Clerk's components need `org:admin`, so the page
 * calls this again before each look; it re-promotes.
 */

const SLUG = "clerk-sso-probe"
const CLERK_API = "https://api.clerk.com/v1"

export interface ProbeState {
  orgId: string
  role: string
  selfServeSso: boolean | null
  selfServeDirectorySync: boolean | null
  connections: unknown[]
}

function devKey(): string {
  if (process.env.NODE_ENV === "production") throw new Error("the probe is dev only")
  const key = process.env.CLERK_SECRET_KEY ?? ""
  if (!key.startsWith("sk_test_"))
    throw new Error("the probe runs on the dev Clerk instance only")
  return key
}

/** The self-serve switches are not in the SDK's types; the raw API takes them. */
async function setSelfServe(key: string, orgId: string) {
  const res = await fetch(`${CLERK_API}/organizations/${orgId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      self_serve_sso_enabled: true,
      self_serve_directory_sync_enabled: true,
    }),
  })
  const body = (await res.json()) as Record<string, unknown>
  if (!res.ok)
    throw new Error(`Clerk refused the self-serve switches: ${JSON.stringify(body)}`)
  return body
}

export async function ensureProbeOrg(): Promise<ProbeState> {
  const key = devKey()
  const { userId } = await auth()
  if (!userId) throw new Error("sign in first")
  const clerk = await clerkClient()

  const org =
    (await clerk.organizations.getOrganization({ slug: SLUG }).catch(() => null)) ??
    (await clerk.organizations.createOrganization({
      name: "Clerk SSO probe",
      slug: SLUG,
      createdBy: userId,
    }))

  const { data: mine } = await clerk.organizations.getOrganizationMembershipList({
    organizationId: org.id,
    userId: [userId],
  })
  const membership = mine[0]
  if (!membership)
    await clerk.organizations.createOrganizationMembership({
      organizationId: org.id,
      userId,
      role: "org:admin",
    })
  else if (membership.role !== "org:admin")
    await clerk.organizations.updateOrganizationMembership({
      organizationId: org.id,
      userId,
      role: "org:admin",
    })

  const flags = await setSelfServe(key, org.id)
  const { data: connections } =
    await clerk.enterpriseConnections.getEnterpriseConnectionList({
      organizationId: org.id,
    })

  return {
    orgId: org.id,
    role: "org:admin",
    selfServeSso: (flags.self_serve_sso_enabled as boolean | undefined) ?? null,
    selfServeDirectorySync:
      (flags.self_serve_directory_sync_enabled as boolean | undefined) ?? null,
    connections: connections.map((c) => JSON.parse(JSON.stringify(c)) as unknown),
  }
}
