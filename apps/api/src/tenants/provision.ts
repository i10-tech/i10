/**
 * Turning a Clerk sign-up into a tenant that can send.
 *
 * ⚠ AN ORGANIZATION IS A TENANT; A USER IS A USER. That is the whole model, and
 * `core.tenants` already assumes it - `clerk_org_id` identifies the tenant and
 * `owner_clerk_user_id` records who created it. Members of an organization
 * share its tenant, its domains, its keys and its bill.
 *
 * ⚠ NOTHING IS CREATED FOR A PERSON WHO SIGNS UP (#325). Until 2026-10-13
 * `user.created` made a personal organization for everybody, whether they
 * wanted one or were about to join a team. Now a workspace exists only once
 * somebody makes it: they name one on onboarding, or pick Personal. Either
 * way Clerk fires `organization.created`, and that is what writes the row - so
 * a team, a Personal workspace and one made in Clerk's dashboard all provision
 * through this one path.
 *
 * ⚠ AND IT IS IDEMPOTENT BY ITSELF, NOT BY THE WEBHOOK DEDUPE.
 * `applyClerkEvent` claims each Svix message id and answers `duplicate` on a
 * redelivery - which is right for the mailbox projection and wrong here: if
 * provisioning failed the first time, the retry is the only chance to fix it,
 * and a dedupe that swallows the retry would leave an account that can never
 * send. So it runs on every delivery and is safe to.
 */

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

export interface TenantStore {
  provision(input: {
    clerkOrgId: string
    slug: string
    name: string
    ownerClerkUserId: string
  }): Promise<{ id: string; created: boolean }>
}

/** Entitlements, narrowed to the one call. See billing/grants.ts on why. */
export interface Entitlements {
  ensureCustomer(input: { tenantId: string; name?: string }): Promise<void>
}

export interface ProvisioningDeps {
  tenants: TenantStore
  /**
   * ⚠ OPTIONAL, AND ITS ABSENCE IS VISIBLE RATHER THAN FATAL. Without it a
   * tenant is created with no entitlement, which means its first send is
   * refused. `missingCustomers()` in send/reconcile.ts is the sweep that finds
   * them; provisioning still succeeds, because a tenant that exists and cannot
   * yet send is recoverable and a sign-up that fails outright is not.
   */
  entitlements?: Entitlements
  log: Logger
}

export type ProvisionOutcome = "tenant_created" | "already_provisioned" | "ignored"

interface ClerkOrganizationPayload {
  id?: unknown
  name?: unknown
  slug?: unknown
  created_by?: unknown
}

export interface TenantProvisioning {
  onOrganizationCreated(data: unknown): Promise<ProvisionOutcome>
}

export function tenantProvisioning(deps: ProvisioningDeps): TenantProvisioning {
  return {
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
      // a connection to another service's latency on the sign-up path. If it
      // fails the
      // tenant still exists, which is the recoverable half.
      if (deps.entitlements) {
        try {
          await deps.entitlements.ensureCustomer({ tenantId: tenant.id, name })
        } catch (error) {
          deps.log.error(
            { err: error, tenantId: tenant.id },
            "tenant created without an entitlement - first send will be refused",
          )
        }
      }

      deps.log.info({ tenantId: tenant.id, orgId }, "provisioned a tenant")
      return "tenant_created"
    },
  }
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
