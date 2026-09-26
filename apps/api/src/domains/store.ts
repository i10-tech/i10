import { eq, and, desc, isNotNull, sql } from "drizzle-orm"
import type { CreateDomain, Domain, DomainStatus, DomainSummary } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { delegations, domains } from "../db/core.js"
import { dnsRecordsFor } from "./records.js"
import { generateDkimKeypair } from "./dkim.js"
import {
  delegatedNameservers,
  delegatedZones,
  delegationRecordsFor,
  ownershipZoneNames,
  returnPathDomain,
} from "./zone.js"
import type { DnsZones } from "./zone.js"
import {
  dkimName,
  nodeTxtLookup,
  proveDomain,
  type DelegationProbe,
  type DnsProbes,
  type Provable,
  type TxtLookup,
} from "./ownership.js"
import { readDelegation } from "./referral.js"
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

/** How an already-added domain is described back to the person adding it again. */
const standing = (status: DomainStatus): string => {
  switch (status) {
    case "verified":
      return "is verified"
    case "failed":
      return "failed verification — open it to fix the records"
    default:
      return "is waiting for verification"
  }
}

export type CreateOutcome =
  | { status: "created"; domain: Domain }
  | { status: "rejected"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "limit"; reason: string }

export interface DomainStore {
  create(tenantId: string, input: CreateDomain): Promise<CreateOutcome>
  /**
   * Why `create` would refuse this name, asked without creating anything.
   *
   * ⚠ ONLY THE REFUSALS ABOUT THE NAME ITSELF — ours, or already in this
   * workspace. The plan limit is left out on purpose: it is not answered by
   * editing the box, and it keeps its own button.
   *
   * ⚠ "VERIFIED BY ANOTHER WORKSPACE" IS NO LONGER ONE OF THEM. A name somebody
   * else holds may be added and verified here, and proving it moves it — see
   * `verify`. Refusing it at the door left an owner who lost the account their
   * domain was in with no way to prove it from a new one.
   */
  refusal(tenantId: string, name: string): Promise<string | null>
  get(tenantId: string, id: string): Promise<Domain | null>
  list(tenantId: string): Promise<DomainSummary[]>
  remove(tenantId: string, id: string): Promise<boolean>
  /** Re-reads the provider and stores what it says. */
  verify(tenantId: string, id: string, options?: VerifyOptions): Promise<VerifyOutcome>
  /**
   * The same question as `verify`, asked cheaply, for polling.
   *
   * ⚠ IT EXISTS BECAUSE `verify` IS A WRITE AGAINST SES AND POLLING IT IS
   * ABUSE. Every `verify` re-asserts the DKIM signing key —
   * `CreateEmailIdentity`, then `PutEmailIdentityDkimSigningAttributes` on the
   * AlreadyExists — which is exactly right once, when the key may have changed,
   * and is two writes against a low-TPS account-wide API every time after that.
   * A console that checks back every few seconds until the badge turns green
   * would have made twenty of those per domain.
   *
   * ⚠ AND IT PROVES NOTHING AND CLAIMS NOTHING. No DNS lookup, no ownership
   * proof, no delegation claim, no zone published — it reads SES's opinion of
   * an identity that `verify` has already established and stores it. A domain
   * that has never been verified has no identity to ask about, so this answers
   * `missing` rather than quietly starting the flow by the back door.
   */
  refresh(tenantId: string, id: string): Promise<RefreshOutcome>
  /**
   * Tears down every domain a workspace holds. For account termination.
   *
   * ⚠ IT EXISTS BECAUSE TERMINATION MARKS THE TENANT DEAD RATHER THAN DELETING
   * IT, so the `on delete cascade` on `domains.tenant_id` never fires and
   * nothing anywhere was tearing these down. What survived a deleted workspace
   * was a live SES identity per domain and a PowerDNS zone still answering for
   * every delegated one — our nameservers serving DKIM keys and return paths
   * for an account that no longer exists, indefinitely, with no way to find
   * them except by reading the database.
   *
   * ⚠ IT IS `remove` IN A LOOP, NOT A SECOND TEARDOWN. Deleting a domain
   * safely means reading who actually holds the delegation and who actually
   * holds the SES identity before touching either — two cross-tenant checks
   * that took two separate bugs to get right. A bulk path with its own copy
   * would be the third.
   */
  releaseDomains(tenantId: string): Promise<ReleaseSummary>
  /**
   * When each of this workspace's displaced domains was taken, by id.
   *
   * ⚠ A SEPARATE READ, NOT A FIELD ON `Domain`, because `Domain` is the public
   * API's shape and which of our other customers took a name is not something
   * that surface says anything about. The console asks for it alongside.
   */
  displaced(tenantId: string): Promise<Record<string, string>>
}

/**
 * A record from a previous holder's setup that still proves the name for them.
 *
 * ⚠ REPORTED TO WHOEVER JUST TOOK THE NAME, BECAUSE IT IS HOW THEY KEEP IT.
 * The latest proof wins, so while the old holder's records are still published
 * the old holder can press Verify and take it straight back. The new holder
 * controls the DNS and can already see these records; naming them says nothing
 * about who the old holder is.
 */
export interface LeftoverRecord {
  type: "TXT" | "NS"
  name: string
  /** For NS, the nameserver the stale record points at. */
  value?: string
}

export interface ReleaseSummary {
  /** Rows deleted, whose SES identity and zones were tidied behind them. */
  released: number
  /**
   * ⚠ COUNTED RATHER THAN THROWN, because the caller is a webhook finishing a
   * deletion. One domain whose row will not delete must not stop the other
   * four, and must not fail a termination that has already stopped the
   * billing — see the note where this is called.
   */
  failed: number
}

/**
 * ⚠ DELIBERATELY NARROWER THAN `VerifyOutcome`. There is no `claimed` and no
 * `unproven` here because this asks nobody for anything it could lose — it
 * cannot take a name from another workspace and it cannot fail a proof it
 * never ran.
 */
export type RefreshOutcome =
  | { status: "ok"; domain: Domain }
  | { status: "missing" }
  /** Never verified, so there is nothing at the provider to ask about. */
  | { status: "not_registered"; domain: Domain }

/**
 * Why a domain could not be proved.
 *
 * ⚠ THE THREE ARE KEPT APART BECAUSE THEY SEND SOMEBODY TO THREE DIFFERENT
 * PLACES. `absent` means publish the records; `unreachable` means we could not
 * ask and nothing is wrong yet; `superseded` means the records are published,
 * correct-looking, and name an older claim — which happens every time a domain
 * is deleted and added again, because the token is per row. Flattening the
 * third into the first is what sends a customer to re-check DNS that is
 * present and correct.
 */
export type UnprovenReason = "absent" | "unreachable" | "superseded"

/**
 * ⚠ `claimed` EXISTS BECAUSE TWO TENANTS MAY HOLD THE SAME NAME AS PENDING.
 * Only one may hold it verified (migration 0039), so the loser of that race
 * needs an answer that is neither "verified" nor "your DNS is wrong" — both
 * would be lies, and the second sends somebody to go and break records that are
 * correct. It is a distinct outcome rather than a `failed` status for exactly
 * that reason.
 */
export type VerifyOutcome =
  | {
      status: "ok"
      domain: Domain
      /** Only when this verify took the name from another workspace. */
      leftover?: LeftoverRecord[]
    }
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
  | { status: "unproven"; domain: Domain; reason: UnprovenReason }

export interface VerifyOptions {
  /**
   * Whether this verify may take a name away from the workspace holding it.
   *
   * ⚠ IT EXISTS SO THAT A SWEEP CAN REUSE `verify` WITHOUT INHERITING ITS ONE
   * DESTRUCTIVE POWER. On the route this is a person pressing a button and
   * waiting for an answer, so contesting is right: if they prove a name the
   * incumbent can no longer prove, the domain has changed hands and should
   * move. Run from a cron on every unproved row in the table, the same code
   * would migrate domains between customers on its own schedule with nobody
   * asking — which is exactly what `catch-up.ts` refuses to do, for the same
   * reason, in its own words: "a poll must never move a domain between
   * customers".
   *
   * ⚠ FALSE DOES NOT MEAN "PRETEND IT VERIFIED". The contest is skipped and the
   * outcome is reported as `claimed`, unchanged — the next verify a person
   * presses resolves it properly. And it is decided BEFORE SES is touched: a
   * sweep that registered the identity first would re-key the holder's signing
   * without moving anything, which is a takeover by a cron.
   *
   * Defaults to true, so every existing caller keeps the behaviour it had.
   */
  contest?: boolean
}

export interface DomainStoreDeps {
  db: Database
  identity: DomainIdentity
  capacity: Capacity
  /** Reported on every domain. One region, so it is configuration, not a column. */
  region: string
  /**
   * The domains i10 itself sends from. `MAIL_DOMAINS`.
   *
   * ⚠ REFUSED RATHER THAN ALLOWED-AND-BROKEN, because every path after this
   * assumes the customer controls the name. Adding `i10.tech` would create a
   * DKIM keypair for a domain whose DNS we already serve, register a second SES
   * identity against our own sending domain, and — on the delegated path — hand
   * a customer's claim the zone that carries OUR SPF and return paths. The
   * first thing to break would be our own mail.
   */
  ownDomains: readonly string[]
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
   * ⚠ READS THE PARENT'S REFERRAL, WHICH NO ORDINARY RESOLVER WILL DO. A
   * delegated domain proves itself through the nameserver names it delegates
   * to, and those can only be read from the zone ABOVE the delegation — see
   * domains/referral.ts. Defaults to the real thing; tests supply their own.
   */
  delegation?: DelegationProbe
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
  /**
   * ⚠ OPTIONAL, AND ADDED BECAUSE ONE OF THESE TIDIES IS NOT A TIDY. A zone we
   * failed to delete stops answering the moment the delegation lapses; an SES
   * identity we failed to delete is a live, billable, still-sending resource
   * for a domain nobody owns, and it is invisible unless somebody reads a warn
   * line. That leak has now been reported twice from production while the log
   * said so both times and nothing was watching `warn`.
   */
  error?: (o: object, m: string) => void
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
  delegated: boolean
  dkimSelector: string | null
  dkimPublicKey: string | null
  status: DomainStatus
  createdAt: Date
  /** Proves WHICH workspace published the delegation. See ownership.ts. */
  delegationToken: string
  /** Set when another workspace proved the name and took it. See the column. */
  displacedAt: Date | null
}

/** Another workspace's row for the same name, as the definer functions return it. */
interface Rival {
  domain_id: string
  tenant_id: string
  delegation_token: string
  dkim_selector: string | null
  dkim_public_key: string | null
  delegated: boolean
}

type Cleared = { status: "clear"; leftover: LeftoverRecord[] } | { status: "taken" }

const COLUMNS = {
  id: domains.id,
  name: domains.name,
  mailFromSubdomain: domains.mailFromSubdomain,
  delegated: domains.delegated,
  dkimSelector: domains.dkimSelector,
  dkimPublicKey: domains.dkimPublicKey,
  status: domains.status,
  createdAt: domains.createdAt,
  delegationToken: domains.delegationToken,
  displacedAt: domains.displacedAt,
}

/**
 * The MAIL FROM name SES must be told about — the one return path both routes
 * write, from the one function that derives it. See `returnPathDomain`.
 */
const mailFromFor = (row: { name: string; mailFromSubdomain: string }): string =>
  returnPathDomain(row.name, row.mailFromSubdomain)

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
  // a manual one publishes four; a client renders `records` and does not need to
  // know which it is looking at.
  records: row.delegated
    ? delegationRecordsFor(
        row.name,
        row.mailFromSubdomain,
        dns.nameservers,
        row.status,
        row.delegationToken,
      )
    : dnsRecordsFor({
        domain: row.name,
        mailFromSubdomain: row.mailFromSubdomain,
        region,
        dkimSelector: row.dkimSelector,
        dkimPublicKey: row.dkimPublicKey,
        spfInclude: dns.spfInclude,
        status: row.status,
      }),
})

/** What customers point at us. Configuration, not columns. */
export interface DnsSettings {
  /** The domain whose SPF record lists our own MTAs, e.g. `_spf.i10.tech`. */
  spfInclude: string
  /** Our authoritative nameservers, for delegated domains. */
  nameservers: readonly string[]
}

/** Postgres's unique violation. Which constraint fired decides what it means. */
const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505"

export function domainStore({
  db,
  identity,
  capacity,
  region,
  ownDomains,
  dns,
  secrets,
  zones,
  txt = nodeTxtLookup(),
  delegation = readDelegation,
  log,
  now = () => new Date(),
}: DomainStoreDeps): DomainStore {
  const probes: DnsProbes = { txt, delegation }

  /**
   * Every OTHER row that holds this name — verified, or serving its delegation.
   *
   * ⚠ THROUGH THE TWO SECURITY DEFINER FUNCTIONS, because row level security
   * makes another workspace's rows invisible to this one by construction. They
   * return the minimum: which row, which workspace, and its proof material, so
   * the holder can be stood down under ITS OWN tenant context below.
   */
  async function rivalsFor(row: Row): Promise<Rival[]> {
    const [verified, delegation] = await Promise.all([
      db.execute(sql`select * from core.verified_holder(${row.name})`),
      db.execute(sql`select * from core.delegation_holder(${row.name})`),
    ])

    const found = new Map<string, Rival>()
    for (const r of [
      ...(verified as unknown as Rival[]),
      ...(delegation as unknown as Rival[]),
    ]) {
      if (r.domain_id !== row.id) found.set(r.domain_id, r)
    }
    return [...found.values()]
  }

  /**
   * Take the name from whoever holds it, for a row that has JUST proved it.
   *
   * ⚠ THE LATEST PROOF WINS, AND THAT IS A DELIBERATE REVERSAL. It used to be a
   * contest: the holder was re-checked, and if they still proved the name it
   * was a tie and nothing moved. That left an owner who lost the account their
   * domain was in with no way back — the old account's records are still in
   * their DNS, so the old account "still proves it" for ever. Now proving the
   * name is enough to take it; the old row is kept, set `failed` so it cannot
   * send, and stamped `displaced_at` so its console can say what happened.
   *
   * ⚠ CALLED ONLY AFTER PROOF, AND BEFORE SES OR THE ZONES ARE TOUCHED. The SES
   * identity and the zones are keyed on the name, so writing them first would
   * hand this row the holder's signing while the holder still reads verified.
   *
   * ⚠ `contest: false` NEVER TAKES ANYTHING. A sweep proving a name somebody
   * else holds reports `taken` and leaves it for a person to press Verify —
   * two workspaces that both still publish their records would otherwise
   * trade the domain back and forth on every run.
   *
   * ⚠ THE HOLDER IS WRITTEN UNDER THE HOLDER'S OWN TENANT, not through a
   * definer. The tenant id comes from `rivalsFor`, never from the request, and
   * row level security still confines the two statements to that one row.
   */
  async function clearTheWay(row: Row, contest: boolean): Promise<Cleared> {
    const rivals = await rivalsFor(row)
    if (rivals.length === 0) return { status: "clear", leftover: [] }
    if (!contest) return { status: "taken" }

    const leftover: LeftoverRecord[] = []
    for (const rival of rivals) {
      await withTenant(db, rival.tenant_id, async (tx) => {
        await tx.delete(delegations).where(eq(delegations.domainId, rival.domain_id))
        await tx
          .update(domains)
          .set({ status: "failed", displacedAt: now(), updatedAt: now() })
          .where(
            and(eq(domains.tenantId, rival.tenant_id), eq(domains.id, rival.domain_id)),
          )
      })
      log?.warn(
        { domain: row.name, displaced: rival.domain_id, by: row.id },
        "domain moved: another workspace proved it",
      )

      leftover.push(...(await stillProvedBy(row.name, rival)))
    }
    return { status: "clear", leftover }
  }

  /**
   * The records that would let a displaced holder take the name straight back.
   *
   * ⚠ `unreachable` REPORTS NOTHING, because it is not evidence either way and
   * the move has already happened. Nothing here can undo it.
   */
  async function stillProvedBy(name: string, rival: Rival): Promise<LeftoverRecord[]> {
    const proof = await proveDomain(
      probes,
      {
        name,
        delegated: rival.delegated,
        delegationToken: rival.delegation_token,
        dkimSelector: rival.dkim_selector,
        dkimPublicKey: rival.dkim_public_key,
      } satisfies Provable,
      dns.nameservers,
    )
    if (!proof.proven) return []

    if (!rival.delegated && rival.dkim_selector) {
      return [{ type: "TXT", name: dkimName(rival.dkim_selector, name) }]
    }
    return ownershipZoneNames(name).flatMap((zone) =>
      delegatedNameservers(dns.nameservers, rival.delegation_token).map((value) => ({
        type: "NS" as const,
        name: zone,
        value,
      })),
    )
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
  /*
   * ⚠ IT REPORTS WHETHER IT ACTUALLY REGISTERED, AND THE CALLER NEEDS THAT TO
   * READ SES HONESTLY. Both early returns below leave no identity behind, so a
   * `not_started` from the status read that follows means two different things
   * depending on which path got here — "nothing exists" or "it exists and
   * Amazon has not looked yet". `verify` collapses that with this boolean; see
   * the floor it applies.
   */
  async function registerIdentity(
    tenantId: string,
    id: string,
    row: Row,
  ): Promise<boolean> {
    if (!row.dkimSelector) return false

    const sealed = await withTenant(db, tenantId, async (tx) => {
      const [key] = await tx
        .select({ sealed: domains.dkimPrivateKeySealed })
        .from(domains)
        .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
        .limit(1)
      return key?.sealed ?? null
    })
    if (!sealed) return false

    await identity.create({
      domain: row.name,
      mailFrom: mailFromFor(row),
      selector: row.dkimSelector,
      privateKey: secrets.open(sealed),
    })

    return true
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
   * ⚠ AND THE ORDER IS PROVE, THEN CLEAR THE WAY, THEN CLAIM, THEN PUBLISH.
   * Every other order hands something over before the evidence arrives.
   */
  async function settleDelegation(
    tenantId: string,
    row: Row,
    sink: DnsZones,
    contest: boolean,
  ): Promise<
    | { status: "ready"; leftover: LeftoverRecord[] }
    | { status: "taken" | UnprovenReason }
  > {
    const alreadyOurs = await withTenant(db, tenantId, async (tx) => {
      const [claim] = await tx
        .select({ domainId: delegations.domainId })
        .from(delegations)
        .where(and(eq(delegations.tenantId, tenantId), eq(delegations.name, row.name)))
        .limit(1)
      return claim?.domainId === row.id
    })

    /*
     * ⚠ BEFORE THE CLAIM, NOT AFTER. A claim taken on arrival and checked later
     * is a claim that was granted on nothing. A row that already holds the
     * claim proved it to get it, and is re-proved only if somebody else now
     * holds the name verified — taking it from them needs today's evidence.
     */
    if (!alreadyOurs || (await rivalsFor(row)).length > 0) {
      const proof = await proveDomain(probes, row, dns.nameservers)
      if (!proof.proven) return { status: proof.reason }
    }

    const cleared = await clearTheWay(row, contest)
    if (cleared.status === "taken") return { status: "taken" }

    if (!alreadyOurs) {
      try {
        await withTenant(db, tenantId, async (tx) =>
          tx.insert(delegations).values({ name: row.name, domainId: row.id, tenantId }),
        )
      } catch (error) {
        // ⚠ A THIRD PARTY CLAIMED IT BETWEEN `clearTheWay` AND HERE. Reported
        // rather than retried — looping would race every other claimant at
        // once, and the next Verify settles it.
        if (!isUniqueViolation(error)) throw error
        return { status: "taken" }
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
      region,
      dkimSelector: row.dkimSelector,
      dkimPublicKey: row.dkimPublicKey,
      spfInclude: dns.spfInclude,
      nameservers: dns.nameservers,
      claim: row.delegationToken,
    })) {
      await sink.put(zone)
    }

    return { status: "ready", leftover: cleared.leftover }
  }

  /*
   * ⚠ OURS, AND A SUBDOMAIN OF OURS. `mail.i10.tech` is a zone this server
   * is authoritative for; letting somebody claim it would delegate our own
   * return path to their tenant.
   */
  function oursRefusal(name: string): string | null {
    if (!ownDomains.some((own) => name === own || name.endsWith(`.${own}`))) return null
    /*
     * ⚠ FUNNY, THEN USEFUL, IN THAT ORDER AND BOTH IN ONE SENTENCE. A
     * joke that does not also say what to do next is a dead end with a
     * smile on it — and this is somebody's first minute in the product,
     * where the thing they need is the next step rather than a laugh.
     */
    return (
      `${name} is ours — we are flattered, genuinely, but we are already ` +
      `using it. Add the domain your own mail comes from.`
    )
  }

  /**
   * Whether this workspace already holds the name.
   *
   * ⚠ ONE FUNCTION FOR `create` AND FOR `refusal`, WHICH IS THE POINT. The
   * console asks `refusal` as somebody types so the box can go red before the
   * button is pressed; if that were a second copy of this read, the day one of
   * them changed the field would promise a name the create then refused.
   *
   * ⚠ ANOTHER WORKSPACE HOLDING IT IS NOT A REFUSAL ANY MORE. Adding a name
   * asserts nothing and touches nothing shared — no SES identity, no zone — so
   * it cannot hurt whoever holds it. Proving it is what moves it, in `verify`.
   */
  async function heldRefusal(tenantId: string, name: string): Promise<string | null> {
    return withTenant(db, tenantId, async (tx) => {
      const [own] = await tx
        .select({ status: domains.status })
        .from(domains)
        .where(and(eq(domains.tenantId, tenantId), eq(domains.name, name)))
        .limit(1)
      return own
        ? `You have already added ${name}, and it ${standing(own.status)}.`
        : null
    })
  }

  return {
    async refusal(tenantId, input) {
      const name = normaliseDomainName(input)
      // A malformed name is the console's own check to report, and it words
      // it better; `create` still refuses it if it arrives anyway.
      if (name === null) return null
      return oursRefusal(name) ?? (await heldRefusal(tenantId, name))
    },

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

      const ours = oursRefusal(name)
      if (ours) return { status: "rejected", reason: ours }

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
       * ⚠ THE CONSTRAINT IS STILL THE DECISION, NOT THIS READ. Two creates in
       * flight at once both pass it and only one survives the insert; the
       * catch below is what makes that safe. This exists to word the ordinary
       * case well.
       */
      const refusal = await heldRefusal(tenantId, name)
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
        /*
         * ⚠ ONLY THIS WORKSPACE'S OWN DUPLICATE CAN REACH HERE. The row is
         * inserted `not_started`, so `domains_verified_name_unique` cannot fire
         * on it, and another workspace holding the name is not a conflict —
         * which is why any unique violation is read as `domains_tenant_name_unique`
         * rather than insisting on a constraint name some drivers drop.
         */
        if (isUniqueViolation(error)) {
          return { status: "conflict", reason: `You have already added ${name}.` }
        }
        throw error
      }
    },

    async displaced(tenantId) {
      const rows = await withTenant(db, tenantId, async (tx) =>
        tx
          .select({ id: domains.id, displacedAt: domains.displacedAt })
          .from(domains)
          .where(and(eq(domains.tenantId, tenantId), isNotNull(domains.displacedAt))),
      )
      return Object.fromEntries(
        rows.flatMap((r) =>
          r.displacedAt ? [[r.id, r.displacedAt.toISOString()]] : [],
        ),
      )
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

    async releaseDomains(tenantId) {
      const held = await this.list(tenantId)

      let released = 0
      let failed = 0

      for (const domain of held) {
        try {
          if (await this.remove(tenantId, domain.id)) released += 1
        } catch (error) {
          /*
           * ⚠ ONE FAILURE MUST NOT TAKE THE REST WITH IT. `remove` already
           * swallows a failing SES call and a failing zone delete — those are
           * tidies and are logged where they happen — so reaching here means
           * the row itself would not delete. That is worth a line and worth
           * counting, and it is not worth abandoning the other domains of a
           * workspace that has already been shut off.
           */
          failed += 1
          log?.warn(
            { err: String(error), tenantId, domain: domain.name },
            "could not release a domain while terminating its workspace",
          )
        }
      }

      return { released, failed }
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
      /*
       * ⚠ AND THE CLAIM ALONE WAS NOT ENOUGH TO ANSWER IT, WHICH LEAKED EVERY
       * ZONE PUBLISHED BEFORE CLAIMS EXISTED. Zones used to be written by
       * `create` — see the note there that begins "NO ZONE IS PUBLISHED HERE
       * ANY MORE" — so a delegated domain from before that change has three
       * live zones and NO row in `core.delegations`. Reading the claim through
       * `withTenant` then returned undefined, `holdsZones` was false, and the
       * delete left our nameservers serving a DKIM key and a return path for a
       * domain nobody owns. In this deployment that is currently EVERY
       * delegated domain: `core.delegations` is empty and `pdns` holds six
       * zones.
       *
       * ⚠ "NO CLAIM MEANS IT IS MINE" WOULD REOPEN THE HOLE THE CLAIM CLOSED.
       * Several workspaces may hold one name as pending, so if two of them hold
       * a claimless name, neither may take the other's zones. The fallback is
       * therefore the strictest one that still helps: no claim AND nobody else
       * holds the name at all.
       *
       * ⚠ IT FAILS IN THE CHEAP DIRECTION, the same rule `ownsIdentity` states
       * below. A zone left behind is republished wholesale by the next verify
       * of that name; a zone deleted out from under somebody stops their mail.
       */
      const holdsZones =
        existing.delegated &&
        (await (async () => {
          /*
           * ⚠ A FAILED LOOKUP MUST NOT FAIL THE DELETE, AND IT DID. This runs
           * BEFORE the row is removed, so anything it throws comes out of the
           * route as "Could not delete the domain — Something went wrong." and
           * the customer cannot delete their domain at all. Observed the first
           * time a deployment ran this code against a database that had not
           * had migration 0051 applied: `core.zone_owner` did not exist, and a
           * missing function turned into an undeletable domain.
           *
           * ⚠ SO IT FAILS IN THE CHEAP DIRECTION, the same rule the rest of
           * this teardown follows: not knowing whose zones these are means
           * leaving them, which costs an inert record that the next verify of
           * the name republishes wholesale — and that the orphan sweep now
           * finds. Blocking the delete costs the customer the one action they
           * asked for.
           */
          let rows: { claim_domain_id: string | null; holders: number }[]
          try {
            rows = (await db.execute(
              sql`select * from core.zone_owner(${existing.name})`,
            )) as unknown as { claim_domain_id: string | null; holders: number }[]
          } catch (error) {
            log?.error?.(
              { err: String(error), tenantId, domain: existing.name },
              "could not read who owns this domain's zones — deleting the row " +
                "anyway and leaving the zones behind",
            )
            return false
          }

          const owner = rows[0]

          /*
           * ⚠ NO ANSWER IS NOT AN ANSWER. A migration not yet applied, a
           * permission lost, a function renamed — any of them returns no row,
           * and a count defaulted to zero would then satisfy "nobody else holds
           * it" and authorise the delete. The absent case has to be the
           * refusing case.
           */
          if (!owner) return false

          // A claim, when there is one, settles it outright.
          if (owner.claim_domain_id) return owner.claim_domain_id === id

          /*
           * ⚠ EXACTLY ONE, NOT "AT MOST ONE". This row is still in the table
           * when the count is taken — it is deleted below — so one means this
           * row alone, and zero means the count did not see what we are holding
           * and cannot be trusted either.
           */
          return Number(owner.holders) === 1
        })())

      /*
       * Whether the SES identity for this NAME is this row's to delete.
       *
       * ⚠ IT IS THE SAME CROSS-TENANT HOLE `holdsZones` ABOVE CLOSES, LEFT OPEN
       * ON THE OTHER HALF OF THE SAME TEARDOWN. SES keys an identity by domain
       * name within ONE AWS ACCOUNT, and several workspaces may hold the same
       * name as pending — migration 0039 exists to allow exactly that, and the
       * note above records `pslhq.app` held by three tenants in production. So
       * a workspace that never verified anything could delete its own pending
       * row and, with it, the SES identity another workspace is SENDING from.
       * Their mail stops, nothing in their console changes, and the cause is a
       * delete in an account they have never heard of.
       *
       * ⚠ TWO CONDITIONS, AND THEY FAIL IN THE CHEAP DIRECTION ON PURPOSE.
       * Leaving an identity behind costs an inert record in AWS that the next
       * `verify` of that name re-asserts anyway; deleting one that is in use
       * stops somebody's mail. So anything uncertain leaves it alone.
       *
       * ⚠ AND `verified_holder` IS READ BEFORE THE ROW GOES, for the same
       * reason `holdsZones` is: afterwards there is nothing left to ask, and
       * the answer would have to be guessed from a row that no longer exists.
       */
      const ownsIdentity =
        existing.status !== "not_started" &&
        (await (async () => {
          const rows = (await db.execute(
            sql`select * from core.verified_holder(${existing.name})`,
          )) as unknown as { domain_id: string }[]
          const holder = rows[0]
          return holder === undefined || holder.domain_id === id
        })())

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
      // ⚠ ONLY THE IDENTITY THIS ROW ACTUALLY OWNS — see `ownsIdentity`. A row
      // that never registered one, or a name another workspace holds verified,
      // leaves it strictly alone.
      if (ownsIdentity) {
        await tidy("ses identity", () => identity.remove(existing.name), "error")
      }

      // ⚠ THE ZONES GO TOO, OR THE DELEGATION OUTLIVES THE DOMAIN. The customer's
      // NS records still point here after a delete, so a zone left behind keeps
      // answering — with a DKIM key and a return path for a domain nobody owns.
      //
      // ⚠ BUT ONLY THE ZONES THIS ROW ACTUALLY HELD. A tenant whose pending row
      // never won the claim has no zones to take away, and taking them anyway
      // is deleting somebody else's DNS.
      if (holdsZones && zones) {
        // The zones are the names this domain's NS records delegate — the
        // record list the customer was shown — so a per-domain return-path
        // label needs no second derivation here.
        const delegated = existing.records.filter((r) => r.type === "NS")
        for (const zone of new Set(delegated.map((r) => r.name))) {
          await tidy("delegated zone", () => zones.remove(zone))
        }
      }

      return true

      async function tidy(
        what: string,
        run: () => Promise<unknown>,
        severity: "warn" | "error" = "warn",
      ): Promise<void> {
        try {
          await run()
        } catch (error) {
          /*
           * ⚠ NEVER SILENCE, AND NOT ALWAYS THE SAME VOLUME. Nothing is broken
           * for the customer either way — their domain is deleted — but the two
           * leaks are not equally serious. A zone left behind stops answering
           * as soon as the delegation lapses; an SES identity left behind is
           * live, billable and still able to send for a domain nobody owns.
           *
           * ⚠ AND THE LOUD ONE IS LOUD BECAUSE THE QUIET ONE WAS NOT READ. This
           * exact line fired in production twice, saying exactly what had
           * happened, while the leak was reported as "deleting the domain does
           * not remove it from SES" — because `warn` reaches the pod log and
           * nothing else. At `error` it reaches the reporter too.
           */
          const where = { err: String(error), tenantId, domain: existing!.name, what }
          const message = `domain deleted, but its ${what} could not be removed — left behind`

          if (severity === "error" && log?.error) log.error(where, message)
          else log?.warn(where, message)
        }
      }
    },

    /*
     * ⚠ THE CHEAP HALF OF `verify`, AND IT SHARES ITS WRITE RATHER THAN ITS
     * DECISIONS. See the note on the interface for why polling `verify` is not
     * an option; what is left once the proving, claiming, publishing and
     * registering are taken out is one `GetEmailIdentity` and one UPDATE.
     */
    async refresh(tenantId, id) {
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
       * ⚠ `not_started` MEANS NO IDENTITY EXISTS YET, so asking SES about one
       * would be asking about a name we have never registered — which for a
       * name ANOTHER workspace holds is not merely useless but a reading of
       * their identity. `verify` is the only thing that may create one, and it
       * only does so after proving ownership.
       */
      if (existing.status === "not_started") {
        return { status: "not_registered", domain: present(existing, region, dns) }
      }

      /*
       * ⚠ A DISPLACED ROW IS NEVER UPDATED FROM SES. The identity is keyed on
       * the name and now belongs to the workspace that took it, so its status
       * is THEIR status — copying `verified` here would hand the name back to
       * the row that lost it, without a proof, on a poll. Only this row's own
       * verify, which proves the name again, may move it.
       */
      if (existing.displacedAt) {
        return { status: "ok", domain: present(existing, region, dns) }
      }

      const seen = await identity.status(existing.name)

      // ⚠ THE SAME RULE `verify` FOLLOWS: the stamp is the moment the domain
      // first became usable and never moves backwards. A poll that happens to
      // catch a `temporary_failure` must not un-verify a working domain.
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

      let row: Row | undefined
      try {
        ;[row] = (await write(seen.status, verifiedAt)) as Row[]
      } catch (error) {
        /*
         * ⚠ THE VERIFIED-NAME INDEX, AND THIS IS NOT THE PLACE TO CONTEST IT.
         * Another workspace holds this name verified; `verify` knows how to
         * ask whether they still prove it and to take the name if they do not,
         * because a person pressed a button and is waiting for an answer. A
         * poll must never move a domain between customers, so it writes the
         * check timestamp against the status the row already had and says
         * nothing. The next `verify` resolves it properly.
         */
        if (!isUniqueViolation(error)) throw error
        ;[row] = (await write(existing.status)) as Row[]
      }

      return row
        ? { status: "ok", domain: present(row, region, dns) }
        : { status: "missing" }
    },

    async verify(tenantId, id, options = {}) {
      const { contest = true } = options

      const existing = await withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select(COLUMNS)
          .from(domains)
          .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
          .limit(1)
        return row as Row | undefined
      })
      if (!existing) return { status: "missing" }

      /**
       * Write down that we looked, without claiming anything about what we saw.
       *
       * ⚠ EVERY UNPROVEN EXIT BELOW USED TO RETURN WITHOUT TOUCHING THE ROW, AND
       * THAT MADE THE ROW UNSWEEPABLE. `dns_checked_at` is the staleness clock
       * every background selector orders and filters on, so a domain that never
       * proves never advances it — and a sweep that picks rows oldest-first
       * would take the same head of the table on every run, for ever, while the
       * rows behind it were never reached. Stamping it is simply true: we did
       * ask, and the answer was "not yet".
       *
       * ⚠ AND IT MOVES NOTHING ELSE. Not the status, not `verified_at`. The
       * only thing it asserts is the time of the question.
       */
      const noteChecked = () =>
        withTenant(db, tenantId, async (tx) =>
          tx
            .update(domains)
            .set({ dnsCheckedAt: now(), updatedAt: now() })
            .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id))),
        )

      /*
       * ⚠ AHEAD OF ASKING SES ANYTHING, because for a delegated domain the
       * record SES is about to look for lives in a zone we have not published
       * yet. Asking first would return `failed` for a customer who has done
       * everything correctly and is simply waiting on us.
       */
      let leftover: LeftoverRecord[] = []

      if (existing.delegated && zones) {
        const settled = await settleDelegation(tenantId, existing, zones, contest)
        if (settled.status !== "ready") {
          await noteChecked()
          const domain = present(existing, region, dns)
          return settled.status === "taken"
            ? { status: "claimed", domain }
            : { status: "unproven", domain, reason: settled.status }
        }
        leftover = settled.leftover
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
        const proof = await proveDomain(probes, existing, dns.nameservers)
        if (!proof.proven) {
          await noteChecked()
          return {
            status: "unproven",
            domain: present(existing, region, dns),
            reason: proof.reason,
          }
        }

        // ⚠ PROVED, SO WHOEVER HOLDS THE NAME STANDS DOWN — before SES below
        // is asked to sign with this row's key. See `clearTheWay`.
        const cleared = await clearTheWay(existing, contest)
        if (cleared.status === "taken") {
          await noteChecked()
          return { status: "claimed", domain: present(existing, region, dns) }
        }
        leftover = cleared.leftover
      }

      // ⚠ ONLY NOW. Ownership has been proved by one route or the other, and
      // nobody else holds the name.
      const registered = await registerIdentity(tenantId, id, existing)

      const read = await identity.status(existing.name)

      /*
       * ⚠ `not_started` CANNOT BE TRUE OF AN IDENTITY WE JUST CREATED, AND
       * WRITING IT ANYWAY MADE THE ROW INVISIBLE TO EVERYTHING. Two things
       * produce it here: SES's own `NOT_STARTED`, and a `NotFoundException`
       * from reading back an identity a moment after creating it — the adapter
       * maps both to the same word. Stored, that word means something entirely
       * different to the rest of the system: `domains_awaiting_provider`
       * excludes it, so the catch-up sweep never asks about the row again, and
       * `ownsIdentity` in `remove` skips it, so deleting the domain leaves the
       * identity behind in SES. A live identity, unwatched and unremovable.
       *
       * ⚠ SO IT IS FLOORED AT `pending`, WHICH IS WHAT IT ACTUALLY IS: an
       * identity exists and nothing has confirmed it. Only when we did NOT
       * register — no selector, no sealed key — is `not_started` still the
       * honest answer, and that is exactly what `registered` distinguishes.
       */
      const seen =
        registered && read.status === "not_started"
          ? { status: "pending" as const }
          : read

      // ⚠ `verified_at` IS SET ONCE AND NEVER MOVED BACKWARDS BY A LATER CHECK.
      // It is the moment the domain first became usable, and things downstream
      // — the mailbox projection, the send path — read it as "has this ever
      // been proven". A transient `temporary_failure` must not un-verify a
      // working domain; `status` carries that, which is what it is for.
      const verifiedAt =
        seen.status === "verified" && existing.status !== "verified" ? now() : undefined

      /*
       * ⚠ `displaced_at` IS CLEARED BY EVERY WRITE HERE, because reaching this
       * line means this row has just proved the name and holds it again.
       */
      const write = (status: DomainStatus, stamp?: Date) =>
        withTenant(db, tenantId, async (tx) =>
          tx
            .update(domains)
            .set({
              status,
              displacedAt: null,
              dnsCheckedAt: now(),
              updatedAt: now(),
              ...(stamp ? { verifiedAt: stamp } : {}),
            })
            .where(and(eq(domains.tenantId, tenantId), eq(domains.id, id)))
            .returning(COLUMNS),
        )

      const done = (row: unknown): VerifyOutcome =>
        row
          ? {
              status: "ok",
              domain: present(row as Row, region, dns),
              ...(leftover.length > 0 ? { leftover } : {}),
            }
          : { status: "missing" }

      try {
        const [row] = await write(seen.status, verifiedAt)
        return done(row)
      } catch (error) {
        /*
         * ⚠ THE ONLY WAY THIS UPDATE CAN VIOLATE A UNIQUE CONSTRAINT IS THE
         * VERIFIED-NAME INDEX, and after `clearTheWay` that means another
         * workspace verified the name in the moments since. Rethrowing left the
         * console pressing Verify against a 500 for ever.
         *
         * ⚠ ONE MORE ROUND, THEN THE CONFLICT. This row has proved the name, so
         * it takes it from the newcomer exactly as it took it from the holder;
         * a second collision is reported rather than chased.
         */
        if (!isUniqueViolation(error)) throw error

        if (contest) {
          const again = await clearTheWay(existing, true)
          if (again.status === "clear") {
            leftover = [...leftover, ...again.leftover]
            try {
              const [moved] = await write(seen.status, verifiedAt ?? now())
              return done(moved)
            } catch (retry) {
              if (!isUniqueViolation(retry)) throw retry
            }
          }
        }

        /*
         * ⚠ THE ROW IS LEFT UNVERIFIED AND THE CHECK IS STILL STAMPED. Marking
         * it `failed` would tell somebody to go and fix DNS that is correct;
         * marking it verified is what the index just refused. And
         * `displaced_at` stays as it was — this row does not hold the name.
         */
        await noteChecked()
        return { status: "claimed", domain: present(existing, region, dns) }
      }
    },
  }
}
