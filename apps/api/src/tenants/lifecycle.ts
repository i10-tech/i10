import type { Logger } from "./provision.js"

/**
 * Turning a deleted Clerk organization into a workspace that has stopped
 * costing money.
 *
 * ⚠ NOTHING USED TO DO THIS, AND THE BILL KEPT ARRIVING. `provision.ts` turns
 * `organization.created` into a tenant; there was no other half. Deleting the
 * account in Clerk removed the identity, left `core.tenants` saying `active`,
 * left the plan assignment on Pro, and left Polar billing a card every month
 * for a workspace nobody could sign in to. The only way to stop it was to find
 * the subscription in Polar's dashboard by hand.
 *
 * ⚠ AND IT IS IMMEDIATE, WHICH IS THE OPPOSITE OF EVERY OTHER DOWNGRADE HERE.
 * `plan-change.ts` defers, because somebody who moves to a cheaper plan has paid
 * for the rest of the month and should keep it. Deletion is not that: there is
 * nobody left to use the remainder, and "we will keep charging you until the
 * 4th" is not an answer anybody accepts about an account they have deleted. The
 * console's own warning says immediately, so this has to mean it — see
 * `revokeSubscription` in billing/polar.ts.
 *
 * ⚠ THE ORDER IS ENTITLEMENT FIRST, POLAR SECOND, AND IT IS CHOSEN FOR THE
 * FAILURE. `terminate` moves the tenant to `deleted` and its assignment to free
 * in one statement, so if the Polar call then throws, the workspace is already
 * switched off on our side and the webhook answers non-2xx so Svix retries the
 * revoke. The other order leaves a window where Polar has stopped billing and
 * we still believe they are entitled — a free Pro plan, granted by an error.
 */

/** What the lifecycle needs of the database. See tenants/db.ts. */
export interface TenantLifecycleStore {
  /**
   * Whether this tenant id still names a live workspace.
   *
   * ⚠ THE ONLY QUESTION THAT SEPARATES A RECLAIM FROM A COLLISION. See
   * routes/checkout-status.ts, which is its one caller.
   */
  isLive(tenantId: string): Promise<boolean>
  /**
   * Marks the tenant dead and drops it to the free allowance, atomically.
   * `null` when no tenant was ever provisioned for that organization.
   */
  terminate(
    clerkOrgId: string,
    freePlanId: string,
  ): Promise<{
    tenantId: string
    polarSubscriptionId: string | null
    alreadyDead: boolean
  } | null>
  /** The live tenants this user owns, for the `user.deleted` sweep. */
  ownedBy(clerkUserId: string): Promise<{ tenantId: string; clerkOrgId: string }[]>
}

/**
 * Tearing down a dead workspace's domains. The one method of `DomainStore` this
 * needs.
 *
 * ⚠ A NARROW PORT RATHER THAN THE STORE, for the reason every other dependency
 * here is narrowed: this module decides WHEN a workspace's resources go, and
 * nothing about it should be able to create a domain, verify one, or read
 * another tenant's.
 */
export interface DomainReleaser {
  releaseDomains(tenantId: string): Promise<{ released: number; failed: number }>
}

/** Ending a subscription now. The one method of `PolarClient` this needs. */
export interface SubscriptionRevoker {
  revokeSubscription(subscriptionId: string): Promise<"revoked" | "already_ended">
}

/**
 * Clerk, narrowed to the one question the `user.deleted` sweep asks.
 *
 * ⚠ IT ASKS WHETHER ANYBODY IS STILL IN THE ORGANIZATION, NOT WHETHER THE
 * ORGANIZATION STILL EXISTS — AND THE FIRST VERSION OF THIS ASKED THE WRONG
 * ONE. Clerk does NOT delete an organization when its last member is deleted.
 * Measured against production 2026-09-20: two organizations whose only members
 * had deleted their accounts both answered `200 OK` with `total_count: 0`, and
 * neither had fired `organization.deleted`. A sweep conditioned on existence
 * therefore terminates nothing, ever, and a deleted account goes on being
 * billed — the exact failure the sweep was written to prevent, reintroduced by
 * the guess it was meant to replace.
 *
 * ⚠ AND MEMBERSHIP IS STILL THE RIGHT LINE RATHER THAN OWNERSHIP. A team whose
 * founder deletes their own account has members, mailboxes and mail in flight,
 * and must keep its plan; an organization nobody is left in cannot be signed
 * into by anyone. Zero members is what "abandoned" means.
 *
 * ⚠ A MISSING ORGANIZATION COUNTS AS ZERO, not as an error. Clerk answering 404
 * means it is gone, which is a stronger form of the same answer.
 */
export interface OrganizationLiveness {
  /** True when at least one member remains. False when none do, or it is gone. */
  hasMembers(clerkOrgId: string): Promise<boolean>
}

export interface LifecycleDeps {
  tenants: TenantLifecycleStore
  /**
   * ⚠ OPTIONAL, AND ITS ABSENCE IS LOUD RATHER THAN SILENT. A deployment with
   * no Polar client can still mark a tenant dead — that half is entirely ours —
   * but it cannot stop the billing, and a deletion that leaves a live
   * subscription behind has to say so where somebody will see it.
   */
  polar?: SubscriptionRevoker
  /**
   * ⚠ OPTIONAL FOR THE SAME REASON `polar` IS, AND ITS ABSENCE IS AS LOUD. The
   * domain store is itself optional — a deployment with no sealing key has no
   * domains at all — but where there are domains and no releaser, a terminated
   * workspace leaves live SES identities and nameservers still answering for
   * its delegated names, and nothing downstream ever asks about them again.
   */
  domains?: DomainReleaser
  /** Asked before terminating on a `user.deleted`. Never on an org event. */
  organizations?: OrganizationLiveness
  freePlanId: string
  log: Logger
}

export type LifecycleOutcome =
  /** Marked dead, and any subscription ended. */
  | "terminated"
  /** A redelivery of a deletion already handled. */
  | "already_terminated"
  /** No tenant was ever provisioned for that organization. */
  | "no_tenant"
  /** Not an event this cares about, or nothing about it was actionable. */
  | "ignored"

export interface TenantLifecycle {
  onOrganizationDeleted(data: unknown): Promise<LifecycleOutcome>
  onUserDeleted(data: unknown): Promise<LifecycleOutcome>
}

export function tenantLifecycle(deps: LifecycleDeps): TenantLifecycle {
  /**
   * Giving back everything the workspace was holding outside our database.
   *
   * ⚠ IT RUNS LAST AND IT NEVER THROWS, AND BOTH HALVES ARE THE POINT. The
   * billing stop above is the part with a deadline and the part Svix retries;
   * a slow SES call or an unreachable nameserver must not delay it, and must
   * not fail a termination that has already succeeded at the thing that costs
   * money. What it leaves behind on a failure is an identity and a zone, which
   * are logged and can be swept later.
   *
   * ⚠ AND IT RUNS ON A REDELIVERY TOO, NOT ONLY ON THE FIRST TERMINATION.
   * `alreadyDead` means we have seen this deletion before; it does not mean
   * the teardown finished, and re-running it is how a partial one repairs
   * itself. A workspace with nothing left costs one empty query.
   */
  async function release(tenantId: string, clerkOrgId: string): Promise<void> {
    if (!deps.domains) {
      /*
       * ⚠ `error`, NOT `warn`, ON THE SAME RULE AS THE MISSING POLAR CLIENT.
       * This is not an absent feature — it is our nameservers going on
       * answering for a deleted customer's mail domains, and a verified SES
       * identity nobody owns, with no trace anywhere that they are orphaned.
       */
      deps.log.error(
        { tenantId, clerkOrgId },
        "workspace deleted but domain teardown is not configured — its SES " +
          "identities and delegated zones are STILL LIVE and must be removed by hand",
      )
      return
    }

    try {
      const { released, failed } = await deps.domains.releaseDomains(tenantId)
      if (released > 0 || failed > 0) {
        deps.log.warn(
          { tenantId, clerkOrgId, released, failed },
          "released a terminated workspace's domains",
        )
      }
    } catch (error) {
      deps.log.error(
        { tenantId, clerkOrgId, err: String(error) },
        "workspace terminated, but its domains could not be released — SES " +
          "identities and delegated zones may be left behind",
      )
    }
  }

  /** The whole of a termination, for one organization we know is gone. */
  async function terminate(clerkOrgId: string): Promise<LifecycleOutcome> {
    const ended = await deps.tenants.terminate(clerkOrgId, deps.freePlanId)

    if (!ended) {
      deps.log.info(
        { clerkOrgId },
        "an organization was deleted that we never provisioned a tenant for",
      )
      return "no_tenant"
    }

    /*
     * ⚠ THE DOMAINS GO ON THE WAY OUT OF EVERY EXIT BELOW, NOT AT ONE OF THEM.
     * There are three ways a termination finishes — no subscription, no Polar
     * client, a revoke that succeeded — and a teardown attached to the last of
     * them would silently skip the two commonest. The only exit it is NOT
     * reached from is the revoke throwing, which is the one Svix retries.
     */
    const finish = async (outcome: LifecycleOutcome): Promise<LifecycleOutcome> => {
      await release(ended.tenantId, clerkOrgId)
      return outcome
    }

    if (!ended.polarSubscriptionId) {
      deps.log.info(
        { tenantId: ended.tenantId, clerkOrgId },
        "terminated a workspace with no subscription to cancel",
      )
      return finish(ended.alreadyDead ? "already_terminated" : "terminated")
    }

    if (!deps.polar) {
      /*
       * ⚠ `error`, NOT `warn`, BECAUSE MONEY KEEPS MOVING. Every other
       * consequence of a missing Polar client is an absent feature; this one is
       * a card that goes on being charged for an account that no longer exists,
       * and nothing downstream will ever ask about it again.
       */
      deps.log.error(
        {
          tenantId: ended.tenantId,
          subscriptionId: ended.polarSubscriptionId,
        },
        "workspace deleted but billing is not configured — its Polar " +
          "subscription is STILL ACTIVE and must be cancelled by hand",
      )
      return finish("terminated")
    }

    /*
     * ⚠ THIS THROWS ON A REAL FAILURE AND THE WEBHOOK ANSWERS 500, WHICH IS THE
     * POINT. Swallowing it would mean the one observable trace of "we deleted
     * the workspace and did not stop the billing" is a log line; letting Svix
     * retry is a repair that happens without anybody reading anything.
     */
    const outcome = await deps.polar.revokeSubscription(ended.polarSubscriptionId)

    deps.log.warn(
      {
        tenantId: ended.tenantId,
        clerkOrgId,
        subscriptionId: ended.polarSubscriptionId,
        outcome,
      },
      "terminated a workspace and ended its subscription immediately",
    )

    return finish(ended.alreadyDead ? "already_terminated" : "terminated")
  }

  return {
    async onOrganizationDeleted(data) {
      const org = (data ?? {}) as { id?: unknown }
      const orgId = typeof org.id === "string" ? org.id : null
      if (!orgId) return "ignored"

      return terminate(orgId)
    },

    /**
     * ⚠ THE SWEEP EXISTS BECAUSE `organization.deleted` MAY NEVER ARRIVE, and
     * the case it covers is the exact one that was reported: somebody deletes
     * their account from the profile panel, which is a `user.deleted`, and the
     * personal organization behind their workspace goes with it — or does not,
     * depending on a Clerk behaviour we cannot assert from here.
     *
     * ⚠ AND IT CONFIRMS WITH CLERK BEFORE ENDING ANYTHING — BY COUNTING
     * MEMBERS, NOT BY ASKING WHETHER THE ORGANIZATION EXISTS. Clerk leaves the
     * organization standing when its last member is deleted, so existence is
     * always true and would gate out every real termination. Owning a tenant is
     * not the same as being the last person in it: a team whose founder deletes
     * their own account still has members and must keep its plan.
     */
    async onUserDeleted(data) {
      const user = (data ?? {}) as { id?: unknown }
      const userId = typeof user.id === "string" ? user.id : null
      if (!userId) return "ignored"

      const owned = await deps.tenants.ownedBy(userId)
      if (owned.length === 0) return "ignored"

      if (!deps.organizations) {
        /*
         * ⚠ WITHOUT CLERK WE DO NOTHING, AND SAY SO. The alternative is
         * terminating on ownership alone, which would switch off a team because
         * one person left — a strictly worse failure than a subscription that
         * runs on until the organization event lands or somebody looks.
         */
        deps.log.warn(
          { clerkUserId: userId, tenants: owned.map((t) => t.tenantId) },
          "a user who owns workspaces was deleted and Clerk cannot be reached " +
            "to check whether anybody is left in them",
        )
        return "ignored"
      }

      let outcome: LifecycleOutcome = "ignored"

      for (const tenant of owned) {
        // ⚠ ONE FAILURE MUST NOT STOP THE REST. Somebody with three workspaces
        // deleting their account is three independent decisions, and an
        // unreachable Clerk for one of them is not a reason to leave the other
        // two billing.
        let inUse: boolean
        try {
          inUse = await deps.organizations.hasMembers(tenant.clerkOrgId)
        } catch (error) {
          deps.log.error(
            { err: String(error), ...tenant },
            "could not ask Clerk whether a deleted user's workspace still has " +
              "anybody in it",
          )
          continue
        }

        if (inUse) continue

        outcome = await terminate(tenant.clerkOrgId)
      }

      return outcome
    },
  }
}
