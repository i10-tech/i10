import { and, eq, inArray, notInArray, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { joinDomains, workspaceRoles } from "../db/core.js"
import {
  bypassUsers,
  connectionDomains,
  connections,
  workspaceSettings,
} from "../db/identity.js"
import {
  authdManagedAccounts,
  authdRequiredDomains,
  authdRequiredExempt,
} from "../db/schema.js"

/**
 * What authd is told about managed accounts (#344): ONE place that writes
 * `authd.managed_accounts`.
 *
 * ⚠ A MANAGED ACCOUNT IS NEVER SENT TO CLERK'S verify_password. authd only
 * knows an account is managed because of the row written here, so every path
 * that makes, moves or ends a managed account (identity/store.ts) goes through
 * these two functions, inside the SAME transaction as the change to
 * `identity.managed_accounts`: a crash cannot leave the account managed in one
 * table and free in the other.
 *
 * ⚠ THE FAILURE THAT MATTERS IS A MISSING ROW, because a missing row reads as
 * "not managed" and a not-managed account is asked of Clerk. The company took
 * its password away, so Clerk would answer no; but the rule is that authd does
 * not ask at all, and the one-writer shape is what keeps it true.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/** The account is managed, and its binds are answered by `connectionId`'s pass-through. */
export async function mirrorManaged(
  tx: Tx,
  clerkUserId: string,
  connectionId: string | null,
): Promise<void> {
  const now = new Date()
  await tx
    .insert(authdManagedAccounts)
    .values({ clerkUserId, connectionId, updatedAt: now })
    .onConflictDoUpdate({
      target: authdManagedAccounts.clerkUserId,
      set: { connectionId, updatedAt: now },
    })
}

/** The account is not managed any more: released, or its user is gone. */
export async function unmirrorManaged(tx: Tx, clerkUserId: string): Promise<void> {
  await tx
    .delete(authdManagedAccounts)
    .where(eq(authdManagedAccounts.clerkUserId, clerkUserId))
}

const liveProof = sql`${joinDomains.verifiedAt} is not null and ${joinDomains.lapsedAt} is null and ${joinDomains.displacedAt} is null`

/**
 * Brings `authd.required_domains` for one workspace to what its connections say
 * NOW: a domain is there while an ACTIVE connection whose enforcement is
 * "required_domain" or "required_all" covers it with a live proof.
 *
 * It RECOMPUTES rather than applying a delta, so it is safe to call after any
 * change that might matter, in any order and more than once - which is how every
 * caller uses it: from inside the tenant transaction of the change itself
 * (connection status or enforcement, a domain attached or detached, a proof
 * lapsing, returning or being displaced), so a crash leaves the change and its
 * mirror together or neither.
 *
 * ⚠ "REQUIRED" MEANS THE SAME IN BOTH MODES HERE, AND IT IS THE DOMAIN. Mail
 * cannot tell who is a member of what; it can tell whose address is on a domain
 * the connection proved. `required_all` therefore covers the connection's live
 * domains too, as `required_domain` does: a member on any other address could
 * never sign in through this connection (the bridge refuses an address off its
 * live domains), so requiring SSO of them would lock them out for good.
 *
 * ⚠ EVERY DOMAIN OF THE WORKSPACE IS REPLACED, NEVER ANOTHER WORKSPACE'S. A name
 * another workspace holds (latest proof wins, so only after displacement) is
 * taken over by the upsert, and that workspace's own recompute removes nothing it
 * no longer owns; authd only applies a row to the workspace's own accounts.
 */
export async function mirrorRequiredDomains(tx: Tx, tenantId: string): Promise<void> {
  const rows = await tx
    .select({ name: joinDomains.name, connectionId: connections.id })
    .from(connectionDomains)
    .innerJoin(
      connections,
      and(
        eq(connections.id, connectionDomains.connectionId),
        eq(connections.tenantId, connectionDomains.tenantId),
      ),
    )
    .innerJoin(
      joinDomains,
      and(
        eq(joinDomains.id, connectionDomains.joinDomainId),
        eq(joinDomains.tenantId, connectionDomains.tenantId),
      ),
    )
    .where(
      and(
        eq(connectionDomains.tenantId, tenantId),
        eq(connections.status, "active"),
        inArray(connections.enforcement, ["required_domain", "required_all"]),
        sql`${liveProof}`,
      ),
    )
  const wanted = new Map(rows.map((r) => [r.name.toLowerCase(), r.connectionId]))

  await tx
    .delete(authdRequiredDomains)
    .where(
      wanted.size === 0
        ? eq(authdRequiredDomains.tenantId, tenantId)
        : and(
            eq(authdRequiredDomains.tenantId, tenantId),
            notInArray(authdRequiredDomains.domain, [...wanted.keys()]),
          ),
    )
  if (wanted.size > 0) {
    const now = new Date()
    await tx
      .insert(authdRequiredDomains)
      .values(
        [...wanted].map(([domain, connectionId]) => ({
          domain,
          tenantId,
          connectionId,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: authdRequiredDomains.domain,
        set: {
          tenantId: sql`excluded.tenant_id`,
          connectionId: sql`excluded.connection_id`,
          updatedAt: now,
        },
      })
  }
  // ⚠ WHO IS EXEMPT FOLLOWS WHICH CONNECTIONS REQUIRE, so a connection that starts
  // or stops requiring changes the set in the same transaction.
  await mirrorRequiredExempt(tx, tenantId)
}

/**
 * Brings `authd.required_exempt` for one workspace to what its roles, settings
 * and bypass lists say NOW: a person is there for each connection that requires
 * SSO (`authd.required_domains`) while they are
 *   - an owner or admin of the workspace and the owner exemption is on
 *     (`owner_exemption`), or
 *   - a member on that connection's bypass list (`bypass`).
 * That is who the console's enforcement gate (identity/enforcement.ts) lets past
 * "required" without SSO, and the owner decided they keep their Clerk password
 * for mail too.
 *
 * It RECOMPUTES rather than applying a delta, like `mirrorRequiredDomains`, and
 * every caller runs it from inside the tenant transaction of the change that can
 * move it: a bypass entry added or removed, the owner exemption approved off or
 * back on, ANY role write (console/roles-db.ts `transact`, the one writer of
 * `core.workspace_roles`, so a demotion or a removed member is covered), and every
 * change `mirrorRequiredDomains` already follows.
 *
 * ⚠ UNDER ONE LOCK PER WORKSPACE, AND IT HAS TO BE THIS ONE. A recompute reads
 * the facts and writes the set; two at once, each blind to the other's uncommitted
 * change, would let the one that commits last put back a pass the other had just
 * taken away - a revoked person exempt again with nothing left to correct it.
 * Serialised, whoever takes the lock reads everything committed before it.
 * `_xact_` because PgBouncer pools by transaction; the lock goes with the commit.
 *
 * ⚠ A BYPASS ENTRY COUNTS ONLY WHILE THE PERSON IS A MEMBER. The console never
 * sees a bypass entry of somebody who has left, because they cannot reach it; mail
 * has no such door, so a stale entry must not keep a removed person's login open.
 *
 * ⚠ ONLY A CONNECTION THAT REQUIRES, per `authd.required_domains`: a bypass entry
 * on a draft or testing connection says nothing about mail until it is active and
 * requires. Nothing here applies to a managed account, which authd answers from
 * its company's directory whatever this says.
 */
export async function mirrorRequiredExempt(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`authd_required_exempt:${tenantId}`}, 0))`,
  )
  const required = await tx
    .selectDistinct({ connectionId: authdRequiredDomains.connectionId })
    .from(authdRequiredDomains)
    .where(eq(authdRequiredDomains.tenantId, tenantId))
  const ids = required.map((r) => r.connectionId)

  const wanted = new Map<
    string,
    { connectionId: string; clerkUserId: string; source: string }
  >()
  const want = (connectionId: string, clerkUserId: string, source: string) =>
    wanted.set(`${connectionId}:${clerkUserId}:${source}`, {
      connectionId,
      clerkUserId,
      source,
    })

  if (ids.length > 0) {
    // No row means the defaults, and the default is exempt (decision 7).
    const [settings] = await tx
      .select({ exemption: workspaceSettings.ownerExemption })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.tenantId, tenantId))
      .limit(1)
    if (settings?.exemption ?? true) {
      const privileged = await tx
        .select({ userId: workspaceRoles.clerkUserId })
        .from(workspaceRoles)
        .where(
          and(
            eq(workspaceRoles.tenantId, tenantId),
            inArray(workspaceRoles.role, ["owner", "admin"]),
          ),
        )
      for (const id of ids)
        for (const p of privileged) want(id, p.userId, "owner_exemption")
    }
    const listed = await tx
      .select({
        connectionId: bypassUsers.connectionId,
        userId: bypassUsers.clerkUserId,
      })
      .from(bypassUsers)
      .innerJoin(
        workspaceRoles,
        and(
          eq(workspaceRoles.tenantId, bypassUsers.tenantId),
          eq(workspaceRoles.clerkUserId, bypassUsers.clerkUserId),
        ),
      )
      .where(
        and(eq(bypassUsers.tenantId, tenantId), inArray(bypassUsers.connectionId, ids)),
      )
    for (const l of listed) want(l.connectionId, l.userId, "bypass")
  }

  await tx.delete(authdRequiredExempt).where(eq(authdRequiredExempt.tenantId, tenantId))
  if (wanted.size === 0) return
  const now = new Date()
  const values = [...wanted.values()].map((w) => ({ ...w, tenantId, updatedAt: now }))
  for (let i = 0; i < values.length; i += 500)
    await tx.insert(authdRequiredExempt).values(values.slice(i, i + 500))
}
