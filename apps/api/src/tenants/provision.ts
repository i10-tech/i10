/**
 * Turning a Clerk sign-up into a tenant that can send.
 *
 * ⚠ AN ORGANIZATION IS A TENANT; A USER IS A USER. That is the whole model, and
 * `core.tenants` already assumes it — `clerk_org_id` identifies the tenant and
 * `owner_clerk_user_id` records who created it. Members of an organization
 * share its tenant, its domains, its keys and its bill.
 *
 * ⚠ WHICH LEAVES A PERSON WHO SIGNS UP AND NEVER MAKES AN ORGANIZATION WITH NO
 * TENANT AND NO WAY TO SEND. So one is made for them: `user.created` creates a
 * personal organization in Clerk, Clerk fires `organization.created`, and that
 * is what writes the row. Two hops rather than one, deliberately — it means a
 * team organization made by hand in the dashboard provisions through exactly
 * the same path as a personal one, instead of having a second code path that is
 * only exercised by real customers.
 *
 * ⚠ AND BOTH HALVES ARE IDEMPOTENT BY THEMSELVES, NOT BY THE WEBHOOK DEDUPE.
 * `applyClerkEvent` claims each Svix message id and answers `duplicate` on a
 * redelivery — which is right for the mailbox projection and wrong here: if
 * provisioning failed the first time, the retry is the only chance to fix it,
 * and a dedupe that swallows the retry would leave an account that can never
 * send. So these run on every delivery and are safe to.
 */

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

/** The slice of Clerk this needs. `clerkClient.organizations` covers it. */
export interface ClerkOrganizations {
  /** How many organizations this user already belongs to. */
  membershipCount(userId: string): Promise<number>
  create(input: { name: string; slug: string; createdBy: string }): Promise<void>
}

export interface TenantStore {
  provision(input: {
    clerkOrgId: string
    slug: string
    name: string
    ownerClerkUserId: string
  }): Promise<{ id: string; created: boolean }>
}

/** Autumn, narrowed to the one call. See billing/grants.ts on why it is narrow. */
export interface Entitlements {
  ensureCustomer(input: { tenantId: string; name?: string }): Promise<void>
}

export interface ProvisioningDeps {
  organizations: ClerkOrganizations
  tenants: TenantStore
  /**
   * ⚠ OPTIONAL, AND ITS ABSENCE IS VISIBLE RATHER THAN FATAL. Without Autumn a
   * tenant is created with no entitlement, which means its first send is
   * refused. `missingCustomers()` in send/reconcile.ts is the sweep that finds
   * them; provisioning still succeeds, because a tenant that exists and cannot
   * yet send is recoverable and a sign-up that fails outright is not.
   */
  entitlements?: Entitlements
  log: Logger
}

export type ProvisionOutcome =
  "organization_created" | "tenant_created" | "already_provisioned" | "ignored"

interface ClerkUserPayload {
  id?: unknown
  first_name?: unknown
  email_addresses?: unknown
}

interface ClerkOrganizationPayload {
  id?: unknown
  name?: unknown
  slug?: unknown
  created_by?: unknown
}

export interface TenantProvisioning {
  onUserCreated(data: unknown): Promise<ProvisionOutcome>
  onOrganizationCreated(data: unknown): Promise<ProvisionOutcome>
}

export function tenantProvisioning(deps: ProvisioningDeps): TenantProvisioning {
  return {
    async onUserCreated(data) {
      const user = (data ?? {}) as ClerkUserPayload
      const userId = typeof user.id === "string" ? user.id : null
      if (!userId) return "ignored"

      // ⚠ ASK BEFORE CREATING, BECAUSE THE RETRY IS THE COMMON CASE. Svix
      // redelivers, and a user invited into a team already has an organization
      // — creating another would give them a second tenant, a second bill and a
      // dashboard that shows the wrong one.
      const existing = await deps.organizations.membershipCount(userId)
      if (existing > 0) return "already_provisioned"

      const label = displayName(user)
      await deps.organizations.create({
        name: label,
        // ⚠ SUFFIXED WITH THE USER ID, BECAUSE CLERK SLUGS ARE GLOBALLY UNIQUE
        // WITHIN AN INSTANCE. Two people called Mohamed would collide on the
        // second sign-up, and the failure would be a 500 on somebody's very
        // first minute with the product.
        slug: slugFor(label, userId),
        createdBy: userId,
      })

      deps.log.info({ userId }, "created a personal organization for a new user")
      // The tenant row is written when Clerk's `organization.created` arrives.
      return "organization_created"
    },

    async onOrganizationCreated(data) {
      const org = (data ?? {}) as ClerkOrganizationPayload
      const orgId = typeof org.id === "string" ? org.id : null
      const createdBy = typeof org.created_by === "string" ? org.created_by : null
      if (!orgId || !createdBy) return "ignored"

      const name = typeof org.name === "string" && org.name ? org.name : orgId
      const slug =
        typeof org.slug === "string" && org.slug ? org.slug : slugFor(name, orgId)

      const tenant = await deps.tenants.provision({
        clerkOrgId: orgId,
        slug,
        name,
        ownerClerkUserId: createdBy,
      })

      if (!tenant.created) return "already_provisioned"

      // ⚠ AFTER THE ROW, AND OUTSIDE ITS TRANSACTION. This is a call to somebody
      // else's service; holding a database transaction open across it would tie
      // a connection to Autumn's latency on the sign-up path. If it fails the
      // tenant still exists, which is the recoverable half.
      if (deps.entitlements) {
        try {
          await deps.entitlements.ensureCustomer({ tenantId: tenant.id, name })
        } catch (error) {
          deps.log.error(
            { err: error, tenantId: tenant.id },
            "tenant created but Autumn does not know it — first send will be refused",
          )
        }
      }

      deps.log.info({ tenantId: tenant.id, orgId }, "provisioned a tenant")
      return "tenant_created"
    },
  }
}

function displayName(user: ClerkUserPayload): string {
  if (typeof user.first_name === "string" && user.first_name.trim()) {
    return user.first_name.trim()
  }

  const addresses = Array.isArray(user.email_addresses) ? user.email_addresses : []
  const first = addresses[0] as { email_address?: unknown } | undefined
  if (typeof first?.email_address === "string") {
    const local = first.email_address.split("@")[0]
    if (local) return local
  }

  return "Workspace"
}

/**
 * A slug Clerk will accept: lowercase, alphanumeric and hyphens, never empty,
 * and made unique by a suffix of the id it belongs to.
 */
function slugFor(label: string, id: string): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "workspace"

  return `${base}-${id.slice(-8).toLowerCase()}`
}
