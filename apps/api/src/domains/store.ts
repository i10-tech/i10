import { eq, and, desc, sql } from "drizzle-orm"
import type { CreateDomain, Domain, DomainStatus, DomainSummary } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { delegations, domains } from "../db/core.js"
import { dnsRecordsFor } from "./records.js"
import { generateDkimKeypair } from "./dkim.js"
import { delegatedZoneNames, delegatedZones, delegationRecordsFor } from "./zone.js"
import type { DnsZones } from "./zone.js"
import {
  nodeTxtLookup,
  proveDomain,
  type Provable,
  type TxtLookup,
} from "./ownership.js"
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
  /**
   * ⚠ THE CHALLENGE RECORD IS NOT THERE YET, WHICH IS NOT A FAILURE. It is the
   * ordinary state of a delegated domain between being added and being set up,
   * and it is the ONLY thing standing between this tenant and a zone — so it
   * has to be said in its own words rather than folded into `failed`, which
   * would send somebody to re-check DNS that is not the problem.
   *
   * ⚠ AND `unreachable` IS SEPARATE FROM `absent` FOR THE SAME REASON SES KEEPS
   * `TEMPORARY_FAILURE` SEPARATE FROM `FAILED`. A nameserver that timed out is
   * not a customer who published nothing.
   */
  | { status: "unproven"; domain: Domain; reason: "absent" | "unreachable" }

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
   * ⚠ READS THE CUSTOMER'S OWN NAMESERVERS, WHICH IS THE ONLY PLACE THE PROOF
   * CAN LIVE. Defaults to a real resolver; tests supply their own, and no other
   * part of this store touches DNS.
   */
  txt?: TxtLookup
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
  /** Proves WHICH workspace published the delegation. See ownership.ts. */
  delegationToken: string
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
  delegationToken: domains.delegationToken,
}

/**
 * The MAIL FROM name SES must be told about.
 *
 * ⚠ THE RETURN PATH MOVES UNDER `mail.` WHEN DELEGATED, and SES has to be told
 * the name it will actually see. Registering `send.example.com` while the zone
 * serves `send.mail.example.com` is a MAIL FROM that never verifies — with
 * records that look correct, because they are, under a different name.
 */
const mailFromFor = (row: {
  name: string
  mailFromSubdomain: string
  delegated: boolean
}): string =>
  row.delegated
    ? `${row.mailFromSubdomain}.${delegatedZoneNames(row.name).mail}`
    : `${row.mailFromSubdomain}.${row.name}`

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
    ? delegationRecordsFor(row.name, dns.nameservers, row.status, row.delegationToken)
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
  txt = nodeTxtLookup(),
  log,
  now = () => new Date(),
}: DomainStoreDeps): DomainStore {
  /**
   * Whether the workspace standing in this one's way can still prove the name.
   *
   * ⚠ PROOF WAS ONE-SHOT, AND DOMAINS CHANGE HANDS. A workspace that proved
   * `example.com` in March keeps the claim and the verified badge for ever; the
   * registration lapses, somebody else buys it, and nothing ever asks again.
   * The new owner publishes everything correctly and is told the name belongs
   * to another workspace — while the previous owner keeps a verified sending
   * identity for a domain that is not theirs, which is the half that matters.
   *
   * ⚠ SO A CHALLENGER WHO HAS ALREADY PROVED IT CAUSES THE INCUMBENT TO BE
   * RE-CHECKED, against the same public DNS, using the incumbent's OWN proof —
   * their challenge token if they delegate, their DKIM selector if they do not.
   * Ownership is decided by what DNS says today rather than by who got here
   * first.
   *
   * ⚠ AND ONLY AN ABSENT PROOF DISPLACES ANYBODY. `unreachable` means we could
   * not ask — a nameserver timed out, a resolver is having a bad afternoon —
   * and treating that as "they no longer own it" would transfer live domains
   * between customers during a DNS outage, which is the most damaging thing
   * this file could possibly do. A failure to ask is never an answer.
   */
  async function incumbentStillProvesIt(
    name: string,
    holder: "delegation" | "verified",
  ): Promise<"displaced" | "held"> {
    const rows = (await db.execute(
      holder === "delegation"
        ? sql`select * from core.delegation_holder(${name})`
        : sql`select * from core.verified_holder(${name})`,
    )) as unknown as {
      domain_id: string
      delegation_token: string
      dkim_selector: string | null
      dkim_public_key: string | null
      delegated: boolean
    }[]

    const incumbent = rows[0]
    // ⚠ NOBODY HOLDS IT ANY MORE — they deleted it between our write failing and
    // this read. The blocker is gone, so the challenger may simply try again.
    if (!incumbent) return "displaced"

    const proof = await proveDomain(txt, {
      name,
      delegated: incumbent.delegated,
      delegationToken: incumbent.delegation_token,
      dkimSelector: incumbent.dkim_selector,
      dkimPublicKey: incumbent.dkim_public_key,
    } satisfies Provable)

    if (proof.proven || proof.reason === "unreachable") return "held"

    await db.execute(sql`select core.displace_domain(${incumbent.domain_id}::uuid)`)
    log?.warn(
      { domain: name, displaced: incumbent.domain_id },
      "domain moved: the holder no longer proves ownership and a challenger does",
    )
    return "displaced"
  }

  /**
   * Tell SES about a domain whose ownership has just been proved.
   *
   * ⚠ CALLED FROM `verify` AND NEVER FROM `create`, which is the whole point.
   * SES keys identities on the domain name inside one AWS account, so this call
   * is not inert for a name another workspace holds — `AlreadyExistsException`
   * sends the adapter into `PutEmailIdentityDkimSigningAttributes`, replacing
   * their signing key with ours. Only a proved owner may reach it.
   *
   * ⚠ AND RE-ASSERTING IS CORRECT RATHER THAN MERELY HARMLESS. After a domain
   * changes hands the new owner's verify runs this, which moves the shared SES
   * identity onto their key — exactly what a transfer has to do.
   *
   * ⚠ THE PRIVATE KEY IS READ IN ITS OWN QUERY, NOT ADDED TO `COLUMNS`. The
   * only secret in this feature has no business travelling inside the row shape
   * that `present()` turns into an API response.
   */
  async function registerIdentity(
    tenantId: string,
    id: string,
    row: Row,
  ): Promise<void> {
    if (!row.dkimSelector) return

    const sealed = await withTenant(db, tenantId, async (tx) => {
      const [key] = await tx
        .select({ sealed: domains.dkimPrivateKeySealed })
        .from(domains)
        .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
        .limit(1)
      return key?.sealed ?? null
    })
    if (!sealed) return

    await identity.create({
      domain: row.name,
      mailFrom: mailFromFor(row),
      selector: row.dkimSelector,
      privateKey: secrets.open(sealed),
    })
  }

  /**
   * Get this tenant to the point where we are serving their delegated zones,
   * or say exactly what is in the way.
   *
   * ⚠ EXTRACTED RATHER THAN INLINED INTO `verify`, because it is a different
   * question with a different answer. `verify` asks the PROVIDER what it
   * believes; this asks whether we should be answering DNS for this name at
   * all, and the two only meet at the end — SES cannot see a DKIM record in a
   * zone we have not published.
   *
   * ⚠ AND THE ORDER IS PROVE, THEN CLAIM, THEN PUBLISH. Every other order hands
   * something over before the evidence arrives.
   */
  async function settleDelegation(
    tenantId: string,
    row: Row,
    sink: DnsZones,
  ): Promise<"ready" | "absent" | "unreachable" | "taken"> {
    const alreadyOurs = await withTenant(db, tenantId, async (tx) => {
      const [claim] = await tx
        .select({ domainId: delegations.domainId })
        .from(delegations)
        .where(and(eq(delegations.tenantId, tenantId), eq(delegations.name, row.name)))
        .limit(1)
      return claim?.domainId === row.id
    })

    if (!alreadyOurs) {
      // ⚠ BEFORE THE CLAIM, NOT AFTER. A claim taken on arrival and checked
      // later is a claim that was granted on nothing.
      const proof = await proveDomain(txt, row)
      if (!proof.proven) return proof.reason

      const claim = () =>
        withTenant(db, tenantId, async (tx) =>
          tx.insert(delegations).values({ name: row.name, domainId: row.id, tenantId }),
        )

      try {
        await claim()
      } catch (error) {
        /*
         * ⚠ SOMEBODY ELSE HOLDS IT, WHICH IS NOT YET AN ANSWER. This tenant has
         * just PROVED the name, so the only question left is whether the
         * incumbent can still prove it too. If they can, it is a tie between
         * two workspaces that both hold the DNS — the same company twice over —
         * and a tie grants nothing. If they cannot, the domain has changed
         * hands and the claim moves with it.
         */
        if (!isUniqueViolation(error)) throw error
        if ((await incumbentStillProvesIt(row.name, "delegation")) === "held") {
          return "taken"
        }

        try {
          await claim()
        } catch (again) {
          // ⚠ A THIRD PARTY GOT IN BETWEEN. One retry, then report the
          // conflict — looping here would be a race against every other
          // claimant at once.
          if (!isUniqueViolation(again)) throw again
          return "taken"
        }
      }
    }

    /*
     * ⚠ REPUBLISHED ON EVERY VERIFY, NOT ONLY ON THE FIRST. `put` replaces the
     * zone wholesale and is idempotent, so this is also the repair path for a
     * zone that was lost — a failed write, a restore, an operator deleting it —
     * and the customer's fix is a button they were already going to press.
     */
    for (const zone of delegatedZones({
      domain: row.name,
      mailFromSubdomain: row.mailFromSubdomain,
      bounceSubdomain: row.bounceSubdomain,
      bounceHost: dns.bounceHost,
      region,
      dkimSelector: row.dkimSelector,
      dkimPublicKey: row.dkimPublicKey,
      spfInclude: dns.spfInclude,
      nameservers: dns.nameservers,
    })) {
      await sink.put(zone)
    }

    return "ready"
  }

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

      /*
       * ⚠ BOTH REFUSALS ARE DECIDED BEFORE SES IS TOUCHED, AND THAT ORDERING IS
       * THE WHOLE POINT OF THIS BLOCK. The identity call below is not inert on
       * a name somebody else already has: SES keys identities on the domain
       * name within one AWS account, so `create` on an existing one raises
       * `AlreadyExistsException` and the adapter recovers by REPLACING its DKIM
       * signing key with ours. Refusing afterwards does not undo that — the
       * other tenant is already signing with a key their DNS does not publish,
       * and their working domain breaks because a stranger typed its name into
       * a form and was told no.
       *
       * ⚠ THE CONSTRAINTS ARE STILL THE DECISION, NOT THESE READS. Two creates
       * in flight at once both pass a check and only one survives the insert;
       * the catch below is what makes that safe. This exists to keep the
       * ordinary, non-racing refusal away from AWS entirely.
       */
      const refusal = await withTenant(db, tenantId, async (tx) => {
        const [own] = await tx
          .select({ id: domains.id })
          .from(domains)
          .where(and(eq(domains.tenantId, tenantId), eq(domains.name, name)))
          .limit(1)
        if (own) return `You have already added ${name}.`

        /*
         * ⚠ THROUGH A SECURITY DEFINER FUNCTION, BECAUSE RLS MAKES THE HONEST
         * QUERY IMPOSSIBLE. Another tenant's rows are invisible here by
         * construction, so asking directly would always answer "free". The
         * function returns a boolean and never the holder — see migration 0043,
         * and the refusal below, which is deliberately careful not to name them.
         */
        const rows = (await tx.execute(
          sql`select core.domain_verified_elsewhere(${name}, ${tenantId}::uuid) as taken`,
        )) as unknown as { taken: boolean }[]

        return rows[0]?.taken
          ? `${name} is already verified by another workspace. If that is ` +
              `yours, remove it there first; if you believe it is not, contact ` +
              `support@i10.tech and we will check ownership.`
          : null
      })

      if (refusal) return { status: "conflict", reason: refusal }

      /*
       * ⚠ SES IS NOT TOLD ABOUT THIS DOMAIN YET, AND THAT IS THE FIX FOR THE
       * WORST OF THE CROSS-TENANT BUGS. SES keys identities on the domain name
       * within ONE AWS ACCOUNT, so `CreateEmailIdentity` for a name another
       * workspace already holds raises `AlreadyExistsException` and our adapter
       * recovers by REPLACING their DKIM signing key with ours. Two workspaces
       * may hold the same name as pending — migration 0039 exists to allow
       * exactly that — so the second one to add it used to silently break the
       * first one's signing, on the MANUAL path, with no delegation involved
       * and nothing on either screen to explain it.
       *
       * ⚠ SO THE IDENTITY IS `verify`'s TO CREATE, ONCE OWNERSHIP IS PROVED.
       * Only one workspace can prove a name, so only one ever writes it — the
       * same rule the zone already follows, applied to the other shared
       * resource. `mailFrom` is derived there from the row rather than carried,
       * because by then it is a fact about the domain rather than an argument.
       *
       * ⚠ AND THE ROW STARTS `not_started`, WHICH IS WHAT SES WOULD HAVE SAID.
       * It is the honest description of a domain that no provider has been
       * asked about yet, and the console already renders it.
       */
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
              status: "not_started",
              sends: true,
              // ⚠ NOT A MAILBOX DOMAIN. This API is Resend's, and Resend has no
              // concept of hosting mail. Turning that on is a separate decision
              // with a separate limit, and defaulting it here would put every
              // sending domain into Stalwart's recipient table.
              hostsMailboxes: false,
            })
            .returning(COLUMNS)

          return inserted
        })

        /*
         * ⚠ NO ZONE IS PUBLISHED HERE ANY MORE, AND THAT IS THE FIX. Adding a
         * domain is somebody typing a name; it asserts nothing. Publishing the
         * zone at that moment meant the second workspace to type an
         * already-delegated name silently replaced the first one's DKIM
         * selector — underneath NS records the real owner had published — and
         * then verified against it.
         *
         * ⚠ SO THE ZONE IS `verify`'s TO PUBLISH, ONCE THE CHALLENGE RESOLVES.
         * That also means adding a domain can no longer fail because somebody
         * else typed it first, which is migration 0039's rule restored: any
         * number of workspaces may hold a name as pending, and proof — not
         * arrival — decides which of them we serve.
         */
        return {
          status: "created",
          domain: present(row as Row, region, dns),
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          /*
           * ⚠ TWO CONSTRAINTS REACH HERE AND THEY MEAN OPPOSITE THINGS, so the
           * message is chosen by which one fired rather than by one sentence
           * covering both. `domains_tenant_name_unique` is this tenant's own
           * duplicate — say so plainly, they can see the other row.
           * `domains_verified_name_unique` is somebody else having PROVED
           * ownership, which is the only case worth refusing at all.
           *
           * ⚠ `delegations_name_unique` DOES NOT REACH HERE, and it used to.
           * The zone is claimed by `verify` now, against a challenge record, so
           * contention over a delegated name is reported there — as `claimed`,
           * after both parties have had the chance to prove it — rather than
           * refused here on arrival order.
           */
          if (isViolationOf(error, "domains_tenant_name_unique")) {
            return {
              status: "conflict",
              reason: `You have already added ${name}.`,
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

      /*
       * ⚠ AHEAD OF ASKING SES ANYTHING, because for a delegated domain the
       * record SES is about to look for lives in a zone we have not published
       * yet. Asking first would return `failed` for a customer who has done
       * everything correctly and is simply waiting on us.
       */
      if (existing.delegated && zones) {
        const settled = await settleDelegation(tenantId, existing, zones)
        if (settled !== "ready") {
          const domain = present(existing, region, dns)
          return settled === "taken"
            ? { status: "claimed", domain }
            : { status: "unproven", domain, reason: settled }
        }
      } else {
        /*
         * ⚠ A MANUAL DOMAIN IS PROVED TOO, AND IT NEEDS NO EXTRA RECORD TO DO
         * IT. Its DKIM selector is generated per domain ROW, so
         * `<selector>._domainkey.<domain>` carrying our public key is already
         * an account-specific fact that only somebody holding the domain's DNS
         * can publish — the same proof the challenge record gives a delegated
         * domain, which a delegated domain cannot use because that name lives
         * in a zone we serve.
         *
         * ⚠ AND CHECKING IT OURSELVES, RATHER THAN LETTING SES BE THE FIRST TO
         * LOOK, IS WHAT KEEPS THE IDENTITY SAFE. Asking SES first means calling
         * `CreateEmailIdentity` for an unproved name, which is exactly how one
         * workspace used to overwrite another's signing key.
         */
        const proof = await proveDomain(txt, existing)
        if (!proof.proven) {
          return {
            status: "unproven",
            domain: present(existing, region, dns),
            reason: proof.reason,
          }
        }
      }

      // ⚠ ONLY NOW. Ownership has been proved by one route or the other.
      await registerIdentity(tenantId, id, existing)

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

        /*
         * ⚠ BUT THIS TENANT HAS JUST PROVED THE NAME, so "somebody else got
         * there first" is only half an answer. The domain may simply have
         * changed hands — a registration lapsed, somebody else bought it — and
         * the incumbent's records may no longer exist at all. Asking them to
         * prove it again is the only way that resolves, and it resolves in the
         * direction DNS actually points.
         */
        if ((await incumbentStillProvesIt(existing.name, "verified")) === "displaced") {
          try {
            const [moved] = await write(seen.status, verifiedAt ?? now())
            if (moved)
              return { status: "ok", domain: present(moved as Row, region, dns) }
          } catch (again) {
            // Somebody else verified in the gap. Fall through and report it.
            if (!isUniqueViolation(again)) throw again
          }
        }

        const [row] = await write(existing.status)
        return row
          ? { status: "claimed", domain: present(row as Row, region, dns) }
          : { status: "missing" }
      }
    },
  }
}
