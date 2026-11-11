import { and, eq, sql } from "drizzle-orm"
import { mailboxAddressSchema } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { domains } from "../db/core.js"
import { accounts, groups } from "../db/schema.js"
import type { StalwartCaller } from "../mail/stalwart.js"
import { disableDomain, ensureDomain } from "../mail/stalwart-domains.js"
import type { MailRevocation } from "../mailboxes/revoke.js"
import { MAILBOX_DOMAINS } from "../metering/levels.js"
import type { Capacity } from "./store.js"

/**
 * Whether a workspace's domain hosts mailboxes, and where its catch-all goes
 * (#406).
 *
 * ⚠ HOSTING NEEDS OWNERSHIP AND NOTHING ELSE. Not SES's verdict on the sending
 * identity: the rule is `core.holds_name` (migration 0147), the same function
 * `core.mailbox_domains()` is built on, so "you may switch this on" and "this is
 * a local recipient" cannot disagree. A displaced row, a lapsed proof or a name
 * another workspace proved later all answer no.
 *
 * ⚠ SENDING IS REPORTED, NEVER REQUIRED. A hosted domain whose SES identity is
 * not verified receives mail and signs people in; mail simply cannot leave it.
 * `sending` is what the console's checklist shows beside the switch.
 *
 * ⚠ OFF IS A DOMAIN-LEVEL GATE, NOT A STAMP ON EACH MAILBOX. The flag leaves the
 * domain out of `core.mailbox_domains()`, which authd reads in the same query as
 * the account it is binding (`core.mailbox_domain_refused`), ahead of its
 * credential cache. So turning it back on needs nothing per mailbox, and a
 * mailbox an admin suspended by hand stays suspended - its `suspended_at` was
 * never ours to touch.
 */

/** Where Stalwart stands after the write, for the console to say "setting up". */
export type StalwartSync =
  /** The Domain object matches. */
  | "synced"
  /** Not reachable or refused: logged and captured, and the reconcile catches up. */
  | "pending"
  /** A domain of that name exists in Stalwart that we did not create; left alone. */
  | "unmanaged"

/** What the console shows beside a domain's hosting switch. */
export interface MailboxesView {
  /** The switch. */
  enabled: boolean
  /** This workspace holds the name now, by proof. Not SES. */
  owned: boolean
  /** SES verified the sending identity, so mail can leave. Separate from hosting. */
  sending: boolean
  /** The last DNS check saw an apex MX pointing at our mail host. */
  receiving: boolean
  /** Where mail to nobody's address goes, or null. */
  catch_all: string | null
  /** Mailboxes on the domain. */
  count: number
}

export type EnableOutcome =
  | { status: "ok"; mailboxes: MailboxesView; stalwart: StalwartSync }
  | { status: "missing" }
  /** This workspace does not hold the name now. */
  | { status: "not_held"; reason: "displaced" | "unowned" }
  | { status: "limit" }

export type CatchAllOutcome =
  | { status: "ok"; mailboxes: MailboxesView; stalwart: StalwartSync }
  | { status: "missing" }
  | { status: "rejected"; reason: string }

export interface MailboxHostingDeps {
  db: Database
  /** The same meter the domains store asks about `domains.sending`. */
  capacity: Capacity
  /** The Stalwart registry, or null where this deployment cannot reach it. */
  stalwart: StalwartCaller | null
  /** `mailRevocation`, for the credentials of a domain that stops hosting. */
  revocation: Pick<MailRevocation, "domainOff">
  log: { warn: (o: object, m: string) => void }
  /** Where a Stalwart failure is captured. The response still succeeds. */
  report?: (error: unknown, context: Record<string, unknown>) => void
  now?: () => Date
}

export interface MailboxHosting {
  /** Every domain of the workspace, by id. One query. */
  forTenant(tenantId: string): Promise<Record<string, MailboxesView>>
  forDomain(tenantId: string, id: string): Promise<MailboxesView | null>
  setEnabled(tenantId: string, id: string, enabled: boolean): Promise<EnableOutcome>
  setCatchAll(
    tenantId: string,
    id: string,
    address: string | null,
  ): Promise<CatchAllOutcome>
}

interface ViewRow {
  id: string
  enabled: boolean
  owned: boolean
  sending: boolean
  receiving: boolean
  catch_all_address: string | null
  count: number | string
}

const asView = (row: ViewRow): MailboxesView => ({
  enabled: row.enabled,
  owned: row.owned,
  sending: row.sending,
  receiving: row.receiving,
  catch_all: row.catch_all_address,
  count: Number(row.count),
})

export function mailboxHosting(deps: MailboxHostingDeps): MailboxHosting {
  const { db, capacity, stalwart, revocation, log } = deps
  const now = () => (deps.now ?? (() => new Date()))()

  /**
   * ⚠ ONE STATEMENT FOR ALL OF A WORKSPACE'S DOMAINS, so the list is not an
   * N+1. `owned` goes through the SECURITY DEFINER function because the proof
   * of another workspace is invisible to this one by construction.
   *
   * ⚠ THE COUNT IS BY THE ADDRESS'S DOMAIN, not by `tenant_id` alone: the column
   * is stale until a person's next Clerk event after a domain changes hands, and
   * null for a mailbox from before it was filled in (which can only be this
   * workspace's on a name it hosts). `authd` has no row level security, so the
   * tenant predicate below is the whole of the isolation.
   */
  const read = async (tenantId: string, only?: string) => {
    const rows = (await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`
        select d.id::text as id,
               d.hosts_mailboxes as enabled,
               (d.displaced_at is null
                 and core.holds_name(d.tenant_id, d.name)) as owned,
               (d.status = 'verified' and d.displaced_at is null) as sending,
               (d.receiving and d.displaced_at is null) as receiving,
               d.catch_all_address,
               (select count(*) from authd.accounts a
                 where lower(split_part(a.email, '@', 2)) = lower(d.name)
                   and (a.tenant_id = d.tenant_id
                        or (a.tenant_id is null and d.hosts_mailboxes))) as count
          from core.domains d
         where d.tenant_id = ${tenantId}::uuid
           ${only ? sql`and d.id = ${only}::uuid` : sql``}
      `),
    )) as unknown as ViewRow[]
    return rows
  }

  const row = async (tenantId: string, id: string) => {
    const [found] = await withTenant(db, tenantId, (tx) =>
      tx
        .select({
          name: domains.name,
          hostsMailboxes: domains.hostsMailboxes,
          displacedAt: domains.displacedAt,
          catchAll: domains.catchAllAddress,
        })
        .from(domains)
        .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
        .limit(1),
    )
    return found ?? null
  }

  const viewOf = async (tenantId: string, id: string): Promise<MailboxesView> => {
    const [found] = await read(tenantId, id)
    // The row was there a moment ago; a vanished one reads as switched off.
    return found
      ? asView(found)
      : {
          enabled: false,
          owned: false,
          sending: false,
          receiving: false,
          catch_all: null,
          count: 0,
        }
  }

  /** Whether this workspace hosts the name now, by the function the list is built on. */
  const hostedBy = async (tenantId: string, name: string): Promise<boolean> => {
    const rows = (await db.execute(
      sql`select 1 as ok
            from core.mailbox_domain_settings(${name.toLowerCase()})
           where tenant_id = ${tenantId}::uuid
           limit 1`,
    )) as unknown as unknown[]
    return rows.length > 0
  }

  /** Whether ANOTHER workspace hosts the name, whose Stalwart domain this must not disable. */
  const hostedElsewhere = async (tenantId: string, name: string): Promise<boolean> => {
    const rows = (await db.execute(
      sql`select 1 as ok
            from core.mailbox_domain_settings(${name.toLowerCase()})
           where tenant_id <> ${tenantId}::uuid
           limit 1`,
    )) as unknown as unknown[]
    return rows.length > 0
  }

  /**
   * ⚠ A STALWART FAILURE IS NEVER THE ANSWER'S FAILURE. The row is the truth and
   * the mail-domains reconcile corrects Stalwart from it every fifteen minutes,
   * so refusing the request because the mail server hiccuped would trap the
   * customer behind a job that is already going to fix it. It is logged and
   * captured, and the response says `pending` so the console can show "setting
   * up" rather than claiming mail works.
   */
  const toStalwart = async (
    tenantId: string,
    name: string,
    write: (call: StalwartCaller) => Promise<StalwartSync>,
  ): Promise<StalwartSync> => {
    if (!stalwart) return "pending"
    try {
      return await write(stalwart)
    } catch (error) {
      log.warn(
        { err: error, tenantId, domain: name },
        "could not update the Stalwart domain; the reconcile will",
      )
      deps.report?.(error, { phase: "stalwart-domain-write", tenantId })
      return "pending"
    }
  }

  const syncOn = (tenantId: string, name: string, catchAll: string | null) =>
    toStalwart(tenantId, name, async (call) =>
      (await ensureDomain(call, name, { catchAllAddress: catchAll })) === "unmanaged"
        ? "unmanaged"
        : "synced",
    )

  return {
    async forTenant(tenantId) {
      const rows = await read(tenantId)
      return Object.fromEntries(rows.map((r) => [r.id, asView(r)]))
    },

    async forDomain(tenantId, id) {
      const [found] = await read(tenantId, id)
      return found ? asView(found) : null
    },

    async setEnabled(tenantId, id, enabled) {
      const domain = await row(tenantId, id)
      if (!domain) return { status: "missing" }
      const name = domain.name.toLowerCase()

      if (!enabled) {
        /*
         * ⚠ THE FLAG FIRST, SO THE DOMAIN HAS LEFT THE LIST AND AUTHD'S GATE IS
         * SHUT BEFORE ANYTHING ELSE RUNS. The revocation below then only makes the
         * return honest (cached passwords), and a throw from it leaves the logins
         * refused and the call repeatable. It runs again when the flag is already
         * off, which is what makes a retry complete the half that failed.
         */
        await withTenant(db, tenantId, (tx) =>
          tx
            .update(domains)
            .set({ hostsMailboxes: false, updatedAt: now() })
            .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id))),
        )
        await revocation.domainOff(tenantId, name)

        // ⚠ ONLY A NAME NOBODY ELSE HOSTS: this row may be a pending twin of the
        // one that actually hosts the name, and disabling it would take their mail.
        const stalwartState = await toStalwart(tenantId, name, async (call) => {
          if (await hostedElsewhere(tenantId, name)) return "synced"
          await disableDomain(call, name)
          return "synced"
        })
        return {
          status: "ok",
          mailboxes: await viewOf(tenantId, id),
          stalwart: stalwartState,
        }
      }

      /*
       * ⚠ OWNERSHIP IS READ FROM THE DATABASE'S OWN RULE, NOT RE-DERIVED. A
       * displaced row is told so by name, because "another workspace proved this"
       * and "you have not proved it" send a person to different places.
       */
      if (domain.displacedAt) return { status: "not_held", reason: "displaced" }
      const held = (await db.execute(
        sql`select core.holds_name(${tenantId}::uuid, ${name}) as held`,
      )) as unknown as { held: boolean }[]
      if (!held[0]?.held) return { status: "not_held", reason: "unowned" }

      /*
       * ⚠ AN ALREADY-ENABLED DOMAIN TAKES NO NEW SLOT, so switching it on again
       * (to retry Stalwart, say) is never refused by the allowance it already
       * counts against. `unentitled` is allowed and not logged here, as on the
       * sending side: it is our plan table's gap, not the customer's.
       */
      if (!domain.hostsMailboxes) {
        const room = await capacity.check({
          tenantId,
          featureId: MAILBOX_DOMAINS,
          requested: 1,
          at: now(),
        })
        if (room.status === "exceeded") return { status: "limit" }

        await withTenant(db, tenantId, (tx) =>
          tx
            .update(domains)
            .set({ hostsMailboxes: true, updatedAt: now() })
            .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id))),
        )
      }

      const stalwartState = await syncOn(tenantId, name, domain.catchAll)
      return {
        status: "ok",
        mailboxes: await viewOf(tenantId, id),
        stalwart: stalwartState,
      }
    },

    async setCatchAll(tenantId, id, address) {
      const domain = await row(tenantId, id)
      if (!domain) return { status: "missing" }
      const name = domain.name.toLowerCase()

      /*
       * ⚠ ONLY A DOMAIN THAT HOSTS MAIL NOW, by the list's own predicate. A
       * catch-all on a domain that does not receive is a setting that does
       * nothing and would read as working.
       */
      if (!(await hostedBy(tenantId, name))) {
        return {
          status: "rejected",
          reason: "Turn on mailboxes for this domain before choosing a catch-all.",
        }
      }

      let target: string | null = null
      if (address !== null) {
        const parsed = mailboxAddressSchema.safeParse(address)
        if (!parsed.success) {
          return { status: "rejected", reason: "That is not an email address." }
        }
        target = parsed.data.toLowerCase()
        const targetDomain = target.slice(target.lastIndexOf("@") + 1)

        // ⚠ A DOMAIN THIS WORKSPACE HOSTS, NOT NECESSARILY THIS ONE: a catch-all
        // may deliver to a mailbox on a sibling domain of the same workspace,
        // never to anybody else's.
        if (!(await hostedBy(tenantId, targetDomain))) {
          return {
            status: "rejected",
            reason: `${targetDomain} is not one of this workspace's mailbox domains.`,
          }
        }
        if (!(await targetExists(db, tenantId, target))) {
          return {
            status: "rejected",
            reason: `${target} is not a mailbox or team inbox of this workspace.`,
          }
        }
      }

      await withTenant(db, tenantId, (tx) =>
        tx
          .update(domains)
          .set({ catchAllAddress: target, updatedAt: now() })
          .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id))),
      )

      const stalwartState = await syncOn(tenantId, name, target)
      return {
        status: "ok",
        mailboxes: await viewOf(tenantId, id),
        stalwart: stalwartState,
      }
    },
  }
}

/**
 * Whether the address is a mailbox, or a team inbox, of this workspace.
 *
 * ⚠ THE DOMAIN HAS ALREADY BEEN CHECKED AS THIS WORKSPACE'S, so an account on it
 * is this workspace's whatever its `tenant_id` says; a team inbox is matched by
 * its own `tenant_id`, which is how the team inbox store scopes it. An alias is
 * not a target: it is somebody else's address and can be reassigned.
 */
async function targetExists(
  db: Database,
  tenantId: string,
  address: string,
): Promise<boolean> {
  const [account] = await db
    .select({ id: accounts.clerkUserId })
    .from(accounts)
    .where(sql`lower(${accounts.email}) = ${address}`)
    .limit(1)
  if (account) return true

  const [inbox] = await db
    .select({ name: groups.name })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), sql`lower(${groups.email}) = ${address}`))
    .limit(1)
  return Boolean(inbox)
}
