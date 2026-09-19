import { eq, and, desc } from "drizzle-orm"
import type { CreateDomain, Domain, DomainStatus, DomainSummary } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { delegations, domains } from "../db/core.js"
import { dnsRecordsFor } from "./records.js"
import { generateDkimKeypair } from "./dkim.js"
import { delegatedZoneNames, delegatedZones, delegationRecordsFor } from "./zone.js"
import type { DnsZones } from "./zone.js"
import type { DomainIdentity } from "./identity.js"
import type { SecretBox } from "../webhooks/signing.js"

/**
 * Domains a tenant has claimed, and what they may do.
 *
 * ⚠ THIS IS THE FIRST PLACE A PLAN LIMIT IS ACTUALLY ENFORCED. The metering
 * package, the level adapter and the entitlement all existed before there was
 * anywhere to call them from — `core.domains` had no writer at all. The check
 * below is that call site.
 */

/**
 * ⚠ THE SLICE OF THE METER THIS NEEDS, AND NOTHING MORE. `Meter` from
 * `@repo/metering` satisfies it structurally. Taking the whole object would
 * hand the domains API `record()`, which writes billable usage — a thing this
 * module has no business being able to do.
 */
export interface Capacity {
  check(input: {
    tenantId: string
    featureId: string
    requested: number
    at: Date
  }): Promise<{ status: string }>
}

/** Every domain created through this API is a sending domain. See `create`. */
export const SENDING_DOMAINS = "domains.sending"

export type CreateOutcome =
  | { status: "created"; domain: Domain }
  | { status: "rejected"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "limit"; reason: string }

export interface DomainStore {
  create(tenantId: string, input: CreateDomain): Promise<CreateOutcome>
  get(tenantId: string, id: string): Promise<Domain | null>
  list(tenantId: string): Promise<DomainSummary[]>
  remove(tenantId: string, id: string): Promise<boolean>
  /** Re-reads the provider and stores what it says. */
  verify(tenantId: string, id: string): Promise<VerifyOutcome>
}

/**
 * ⚠ `claimed` EXISTS BECAUSE TWO TENANTS MAY HOLD THE SAME NAME AS PENDING.
 * Only one may hold it verified (migration 0039), so the loser of that race
 * needs an answer that is neither "verified" nor "your DNS is wrong" — both
 * would be lies, and the second sends somebody to go and break records that are
 * correct. It is a distinct outcome rather than a `failed` status for exactly
 * that reason.
 */
export type VerifyOutcome =
  | { status: "ok"; domain: Domain }
  | { status: "missing" }
  | { status: "claimed"; domain: Domain }

export interface DomainStoreDeps {
  db: Database
  identity: DomainIdentity
  capacity: Capacity
  /** Reported on every domain. One region, so it is configuration, not a column. */
  region: string
  dns: DnsSettings
  /**
   * ⚠ OPTIONAL, AND ITS ABSENCE MAKES DELEGATION IMPOSSIBLE RATHER THAN
   * SILENT. A deployment with no nameserver cannot serve a delegated zone, so
   * asking for one is refused with a reason instead of creating a domain whose
   * NS records point at nothing.
   */
  zones?: DnsZones
  /**
   * ⚠ SEALS THE DKIM PRIVATE KEY BEFORE IT REACHES A ROW. Anyone holding it can
   * sign mail as the customer's domain, so it never lands in the database in a
   * form a backup or a replica could use.
   */
  secrets: SecretBox
  /**
   * ⚠ OPTIONAL, AND IT EXISTS FOR `remove`'s CLEANUP. Deleting a domain is a
   * row delete followed by two best-effort tidies at other systems; those
   * tidies must not fail the delete, so their failures need somewhere to go
   * that is not the caller. Without it they would be swallowed silently, which
   * is the half of this that would be worse.
   */
  log?: Logger
  now?: () => Date
}

/** The slice of the logger this module uses. Structurally satisfied by pino. */
export interface Logger {
  warn: (o: object, m: string) => void
}

/**
 * ⚠ A HOSTNAME, NOT A URL AND NOT AN ADDRESS. Both are things people paste into
 * this field, and both would create a domain that can never verify — silently,
 * because the record names would be built from the wrong string. Rejecting them
 * here costs one regex and saves a support conversation that starts "I added
 * the records and nothing happened".
 */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

export function normaliseDomainName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\.$/, "")
  if (name.includes("@") || name.includes("/") || name.includes(" ")) return null
  return HOSTNAME.test(name) ? name : null
}

interface Row {
  id: string
  name: string
  mailFromSubdomain: string
  bounceSubdomain: string
  delegated: boolean
  dkimSelector: string | null
  dkimPublicKey: string | null
  status: DomainStatus
  createdAt: Date
}

const COLUMNS = {
  id: domains.id,
  name: domains.name,
  mailFromSubdomain: domains.mailFromSubdomain,
  bounceSubdomain: domains.bounceSubdomain,
  delegated: domains.delegated,
  dkimSelector: domains.dkimSelector,
  dkimPublicKey: domains.dkimPublicKey,
  status: domains.status,
  createdAt: domains.createdAt,
}

const summarise = (row: Row, region: string): DomainSummary => ({
  object: "domain",
  id: row.id,
  name: row.name,
  status: row.status,
  created_at: row.createdAt.toISOString(),
  region,
  delegated: row.delegated,
})

const present = (row: Row, region: string, dns: DnsSettings): Domain => ({
  ...summarise(row, region),
  // ⚠ THE SAME FIELD EITHER WAY. A delegating customer publishes NS records and
  // a manual one publishes six; a client renders `records` and does not need to
  // know which it is looking at.
  records: row.delegated
    ? delegationRecordsFor(row.name, dns.nameservers, row.status)
    : dnsRecordsFor({
        domain: row.name,
        mailFromSubdomain: row.mailFromSubdomain,
        bounceSubdomain: row.bounceSubdomain,
        bounceHost: dns.bounceHost,
        region,
        dkimSelector: row.dkimSelector,
        dkimPublicKey: row.dkimPublicKey,
        spfInclude: dns.spfInclude,
        status: row.status,
      }),
})

/** The two names customers point at us. Configuration, not columns. */
export interface DnsSettings {
  /** The domain whose SPF record lists our own MTAs, e.g. `_spf.i10.tech`. */
  spfInclude: string
  /** Our inbound host, which receives bounces for the direct route. */
  bounceHost: string
  /** Our authoritative nameservers, for delegated domains. */
  nameservers: readonly string[]
}

/** Postgres's unique violation. Which constraint fired decides what it means. */
const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505"

/**
 * ⚠ MATCHED ON `constraint` FIRST AND THE MESSAGE ONLY AS A FALLBACK. Postgres
 * puts the constraint name in its own field on the error, which is exact;
 * driver wrappers do not all forward it, and the ones that do not still carry
 * the name inside the message text. Reading only the message would misclassify
 * a constraint whose name is a substring of another's.
 */
const isViolationOf = (error: unknown, constraint: string) => {
  const e = error as { constraint?: string; message?: string }
  return e.constraint === constraint || (e.message?.includes(constraint) ?? false)
}

export function domainStore({
  db,
  identity,
  capacity,
  region,
  dns,
  secrets,
  zones,
  log,
  now = () => new Date(),
}: DomainStoreDeps): DomainStore {
  return {
    async create(tenantId, input) {
      const name = normaliseDomainName(input.name)
      if (name === null) {
        return {
          status: "rejected",
          reason: `${input.name} is not a domain name. Use the bare hostname, like example.com.`,
        }
      }

      // ⚠ CHECKED BEFORE THE IDENTITY IS CREATED, NOT AFTER. Creating the SES
      // identity first and then refusing would leave a verified identity in AWS
      // that no row points at — invisible, billable, and still able to send.
      //
      // ⚠ AND IT COUNTS UNVERIFIED DOMAINS, which is the level adapter's rule
      // rather than a choice made here: a pending domain is a row the customer
      // created and can see, so it holds its slot.
      const room = await capacity.check({
        tenantId,
        featureId: SENDING_DOMAINS,
        requested: 1,
        at: now(),
      })

      if (room.status === "exceeded") {
        return {
          status: "limit",
          reason: "You have used every domain your plan includes.",
        }
      }

      // ⚠ `unentitled` IS NOT A REFUSAL HERE, FOR THE SAME REASON IT IS NOT ONE
      // ON THE SEND PATH. It means the tenant holds no plan or the plan grants
      // no domains — our misconfiguration, not their fault — and the policy
      // this codebase has already chosen for that is to allow and log.

      const delegated = input.delegated ?? false
      if (delegated && !zones) {
        return {
          status: "rejected",
          reason: "Delegated domains are not available on this deployment.",
        }
      }

      const mailFromSubdomain = input.custom_return_path ?? "send"

      // ⚠ GENERATED HERE, NOT BY THE PROVIDER, AND THAT IS WHAT MAKES THE
      // ROUTING DECISION POSSIBLE. One key we own signs on both routes, so the
      // customer publishes one DKIM record whether a message leaves through SES
      // or through our own MTA.
      const keypair = generateDkimKeypair()

      // ⚠ THE RETURN PATH MOVES UNDER `mail.` WHEN DELEGATED, and SES has to be
      // told the name it will actually see. Registering `send.example.com`
      // while the zone serves `send.mail.example.com` is a MAIL FROM that never
      // verifies — with records that look correct because they are, under a
      // different name.
      const mailFrom = delegated
        ? `${mailFromSubdomain}.${delegatedZoneNames(name).mail}`
        : `${mailFromSubdomain}.${name}`

      const created = await identity.create({
        domain: name,
        mailFrom,
        selector: keypair.selector,
        privateKey: keypair.privateKey,
      })

      try {
        const [row] = await withTenant(db, tenantId, async (tx) => {
          const inserted = await tx
            .insert(domains)
            .values({
              tenantId,
              name,
              mailFromSubdomain,
              delegated,
              dkimSelector: keypair.selector,
              dkimPublicKey: keypair.publicKey,
              dkimPrivateKeySealed: secrets.seal(keypair.privateKey),
              status: created.status,
              sends: true,
              // ⚠ NOT A MAILBOX DOMAIN. This API is Resend's, and Resend has no
              // concept of hosting mail. Turning that on is a separate decision
              // with a separate limit, and defaulting it here would put every
              // sending domain into Stalwart's recipient table.
              hostsMailboxes: false,
            })
            .returning(COLUMNS)

          /*
           * ⚠ THE ZONES ARE CLAIMED IN THE SAME TRANSACTION AS THE ROW, AND
           * THAT IS WHAT MAKES THE RACE SAFE RATHER THAN MERELY UNLIKELY. Two
           * tenants adding the same delegated name concurrently both pass any
           * check we could do beforehand; only a constraint decides. The insert
           * below is the decision, and the loser's whole transaction — row
           * included — rolls back, so there is no half-created domain whose
           * zone belongs to somebody else.
           *
           * ⚠ AND IT IS THE `delegated` ONES ONLY. A manual domain publishes no
           * zone, so there is nothing for two tenants to contend over; making
           * them claim the name too would resurrect exactly the squat that
           * migration 0039 was written to remove.
           */
          if (delegated) {
            await tx.insert(delegations).values({
              name,
              domainId: (inserted[0] as Row).id,
              tenantId,
            })
          }

          return inserted
        })

        // ⚠ AFTER THE ROW, AND OUTSIDE ITS TRANSACTION ON PURPOSE. A zone
        // published for a domain that failed to insert is a delegation
        // answering for a customer we have no record of; the other order leaves
        // a domain whose zone is missing, which `verify` repairs by publishing
        // it again. Only one of the two is invisible.
        if (delegated && zones) {
          for (const zone of delegatedZones({
            domain: name,
            mailFromSubdomain,
            bounceSubdomain: "bounce",
            bounceHost: dns.bounceHost,
            region,
            dkimSelector: keypair.selector,
            dkimPublicKey: keypair.publicKey,
            spfInclude: dns.spfInclude,
            nameservers: dns.nameservers,
          })) {
            await zones.put(zone)
          }
        }

        return {
          status: "created",
          domain: present(row as Row, region, dns),
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          /*
           * ⚠ THREE CONSTRAINTS REACH HERE AND THEY MEAN DIFFERENT THINGS, so
           * the message is chosen by which one fired rather than by one
           * sentence covering all of them. `domains_tenant_name_unique` is this
           * tenant's own duplicate — say so plainly, they can see the other
           * row. `delegations_name_unique` is somebody else already serving the
           * zones. `domains_verified_name_unique` is somebody else having
           * PROVED ownership.
           */
          if (isViolationOf(error, "domains_tenant_name_unique")) {
            return {
              status: "conflict",
              reason: `You have already added ${name}.`,
            }
          }

          /*
           * ⚠ REFUSED WITHOUT THE DOMAIN BEING CREATED AT ALL, WHICH IS THE
           * ONLY HONEST ANSWER HERE. Falling back to a manual domain would
           * silently give them something other than what they asked for, and
           * creating a delegated row we will never publish a zone for is a
           * domain that can never verify with nothing on screen saying why.
           *
           * ⚠ AND IT IS PHRASED AS "DELEGATED", NOT "VERIFIED", because the
           * holder may well have proved nothing — first-come is the whole point
           * of that claim. Telling somebody their domain is "already verified
           * by another workspace" when it is not would send them to support
           * with a question support cannot answer from the row.
           */
          if (isViolationOf(error, "delegations_name_unique")) {
            return {
              status: "conflict",
              reason:
                `${name} is already delegated to another workspace. If that is ` +
                `yours, remove it there first — or add ${name} without ` +
                `delegation and publish the records yourself. If you believe ` +
                `neither, contact support@i10.tech and we will check ownership.`,
            }
          }

          /*
           * ⚠ THE WORDING STILL DOES NOT NAME THE OTHER TENANT, and that has
           * not changed. "Acme Ltd already has example.com" turns this endpoint
           * into a way to ask which domains are customers of ours. It does now
           * say what would resolve it, because for the person who genuinely
           * owns the domain there IS something to do.
           */
          return {
            status: "conflict",
            reason:
              `${name} is already verified by another workspace. If that is ` +
              `yours, remove it there first; if you believe it is not, contact ` +
              `support@i10.tech and we will check ownership.`,
          }
        }
        throw error
      }
    },

    async get(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select(COLUMNS)
          .from(domains)
          .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
          .limit(1)
        return row ? present(row as Row, region, dns) : null
      })
    },

    async list(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select(COLUMNS)
          .from(domains)
          .where(eq(domains.tenantId, tenantId))
          .orderBy(desc(domains.createdAt))
        return rows.map((row) => summarise(row as Row, region))
      })
    },

    async remove(tenantId, id) {
      const existing = await this.get(tenantId, id)
      if (!existing) return false

      /*
       * ⚠ READ BEFORE THE ROW GOES, BECAUSE THE CLAIM CASCADES WITH IT. After
       * the delete below there is nothing left to ask, and the question has to
       * be answered from somewhere — the old code answered it from
       * `existing.delegated`, which says only that THIS tenant asked for
       * delegation, not that this tenant is the one being served.
       *
       * ⚠ AND THAT IS WHAT MADE THE DELETE CROSS-TENANT. Any tenant holding a
       * pending row for a name could remove the zones of whoever actually held
       * it: their own delete succeeded, and somebody else's mail stopped
       * resolving. `pslhq.app` is currently held by three tenants in
       * production, so this was one delete away from happening.
       */
      const holdsZones =
        existing.delegated &&
        (await withTenant(db, tenantId, async (tx) => {
          const [claim] = await tx
            .select({ domainId: delegations.domainId })
            .from(delegations)
            .where(
              and(
                eq(delegations.tenantId, tenantId),
                eq(delegations.name, existing.name),
              ),
            )
            .limit(1)
          return claim?.domainId === id
        }))

      // ⚠ THE ROW GOES FIRST, AND THE ORDER IS THE OPPOSITE OF `create`'s ON
      // PURPOSE. Both orders leak something if the second step fails; this one
      // leaks an unused SES identity, which is inert. The other leaves a row
      // pointing at an identity that no longer exists, so every send from it
      // fails and the customer cannot delete it to fix that.
      await withTenant(db, tenantId, async (tx) =>
        tx
          .delete(domains)
          .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id))),
      )

      /*
       * ⚠ EVERYTHING BELOW IS CLEANUP AFTER AN ALREADY-COMMITTED DELETE, AND A
       * FAILURE IN IT MUST NOT BE REPORTED AS A FAILED DELETE. The row is gone
       * the moment the statement above returns; throwing from here made the
       * route answer 500 while the domain had in fact been deleted, so the
       * console said "Could not delete the domain" and a reload showed it
       * deleted anyway. That is the worst shape an error can take — it teaches
       * people that our errors are noise, and the next real one is ignored too.
       *
       * ⚠ AND BOTH TIDIES ARE GENUINELY ALLOWED TO FAIL. SES answers
       * NotFoundException for an identity that was never created — which is
       * every domain added while the identity call was failing — and the zone
       * delete touches a second system that can be down. Neither can resurrect
       * the domain, so neither is worth a 500 the customer cannot act on.
       */
      await tidy("ses identity", () => identity.remove(existing.name))

      // ⚠ THE ZONES GO TOO, OR THE DELEGATION OUTLIVES THE DOMAIN. The customer's
      // NS records still point here after a delete, so a zone left behind keeps
      // answering — with a DKIM key and a return path for a domain nobody owns.
      //
      // ⚠ BUT ONLY THE ZONES THIS ROW ACTUALLY HELD. A tenant whose pending row
      // never won the claim has no zones to take away, and taking them anyway
      // is deleting somebody else's DNS.
      if (holdsZones && zones) {
        for (const zone of Object.values(delegatedZoneNames(existing.name))) {
          await tidy("delegated zone", () => zones.remove(zone))
        }
      }

      return true

      async function tidy(what: string, run: () => Promise<unknown>): Promise<void> {
        try {
          await run()
        } catch (error) {
          // ⚠ WARN, NOT ERROR, AND NOT SILENCE. Nothing is broken for the
          // customer — their domain is deleted — but an identity or a zone we
          // failed to remove is a real leak somebody has to reconcile, and it
          // is invisible unless it is written down.
          log?.warn(
            { err: String(error), tenantId, domain: existing!.name, what },
            `domain deleted, but its ${what} could not be removed — left behind`,
          )
        }
      }
    },

    async verify(tenantId, id) {
      const existing = await withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select(COLUMNS)
          .from(domains)
          .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
          .limit(1)
        return row as Row | undefined
      })
      if (!existing) return { status: "missing" }

      const seen = await identity.status(existing.name)

      // ⚠ `verified_at` IS SET ONCE AND NEVER MOVED BACKWARDS BY A LATER CHECK.
      // It is the moment the domain first became usable, and things downstream
      // — the mailbox projection, the send path — read it as "has this ever
      // been proven". A transient `temporary_failure` must not un-verify a
      // working domain; `status` carries that, which is what it is for.
      const verifiedAt =
        seen.status === "verified" && existing.status !== "verified" ? now() : undefined

      const write = (status: DomainStatus, stamp?: Date) =>
        withTenant(db, tenantId, async (tx) =>
          tx
            .update(domains)
            .set({
              status,
              dnsCheckedAt: now(),
              updatedAt: now(),
              ...(stamp ? { verifiedAt: stamp } : {}),
            })
            .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
            .returning(COLUMNS),
        )

      try {
        const [row] = await write(seen.status, verifiedAt)
        return row
          ? { status: "ok", domain: present(row as Row, region, dns) }
          : { status: "missing" }
      } catch (error) {
        /*
         * ⚠ THE ONLY WAY THIS UPDATE CAN VIOLATE A UNIQUE CONSTRAINT IS THE
         * VERIFIED-NAME INDEX, and it means another tenant proved ownership of
         * this name first. Rethrowing left the console pressing Verify against
         * a 500 for ever, with no sentence anywhere saying why.
         *
         * ⚠ THE ROW IS LEFT UNVERIFIED AND THE CHECK IS STILL STAMPED. Marking
         * it `failed` would tell somebody to go and fix DNS that is correct;
         * marking it verified is what the index just refused. Pending is the
         * honest state, and `claimed` is how the route says why.
         */
        if (!isUniqueViolation(error)) throw error

        const [row] = await write(existing.status)
        return row
          ? { status: "claimed", domain: present(row as Row, region, dns) }
          : { status: "missing" }
      }
    },
  }
}
