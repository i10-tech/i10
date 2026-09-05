import { eq, and, desc } from "drizzle-orm"
import type { CreateDomain, Domain, DomainStatus, DomainSummary } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { domains } from "../db/core.js"
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
  /** Re-reads the provider and stores what it says. `null` if no such domain. */
  verify(tenantId: string, id: string): Promise<Domain | null>
}

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
  now?: () => Date
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

/** Postgres's unique violation. The name is unique across every tenant. */
const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505"

export function domainStore({
  db,
  identity,
  capacity,
  region,
  dns,
  secrets,
  zones,
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
        const [row] = await withTenant(db, tenantId, async (tx) =>
          tx
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
            .returning(COLUMNS),
        )

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
          // ⚠ THE NAME IS UNIQUE ACROSS TENANTS, so this is either their own
          // duplicate or somebody else's domain — and the message must not say
          // which. "Somebody already has example.com" tells an attacker which
          // domains are customers of ours.
          return {
            status: "conflict",
            reason: "That domain is already registered.",
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

      await identity.remove(existing.name)

      // ⚠ THE ZONES GO TOO, OR THE DELEGATION OUTLIVES THE DOMAIN. The customer's
      // NS records still point here after a delete, so a zone left behind keeps
      // answering — with a DKIM key and a return path for a domain nobody owns.
      if (existing.delegated && zones) {
        for (const zone of Object.values(delegatedZoneNames(existing.name))) {
          await zones.remove(zone)
        }
      }

      return true
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
      if (!existing) return null

      const seen = await identity.status(existing.name)

      // ⚠ `verified_at` IS SET ONCE AND NEVER MOVED BACKWARDS BY A LATER CHECK.
      // It is the moment the domain first became usable, and things downstream
      // — the mailbox projection, the send path — read it as "has this ever
      // been proven". A transient `temporary_failure` must not un-verify a
      // working domain; `status` carries that, which is what it is for.
      const verifiedAt =
        seen.status === "verified" && existing.status !== "verified" ? now() : undefined

      const [row] = await withTenant(db, tenantId, async (tx) =>
        tx
          .update(domains)
          .set({
            status: seen.status,
            dnsCheckedAt: now(),
            updatedAt: now(),
            ...(verifiedAt ? { verifiedAt } : {}),
          })
          .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
          .returning(COLUMNS),
      )

      return row ? present(row as Row, region, dns) : null
    },
  }
}
