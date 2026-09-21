import { Resolver } from "node:dns/promises"
import { readDelegation, type ReferralResult } from "../domains/referral.js"
import { delegatedZoneNames } from "../domains/zone.js"

/**
 * Why a delegated domain has not verified.
 *
 * ⚠ THIS EXISTS BECAUSE "PRESS VERIFY, NOTHING HAPPENS" WAS THE WHOLE
 * EXPERIENCE, and every sentence the product offered in that state was a guess.
 * `DomainStore.verify` asks SES, and SES answers `pending` for every reason at
 * once: records not published, records published wrong, delegation pointed
 * somewhere else, or our own nameservers not answering. The console then
 * rendered the one message it had — "this is normal, it can take up to 72
 * hours" — which is true for the first of those and actively misleading for the
 * other three. Somebody waits three days for a condition that will never clear.
 *
 * ⚠ IT DIAGNOSES; IT DOES NOT VERIFY, AND THE DISTINCTION IS THE SAME ONE
 * `dns.ts` MAKES AT LENGTH. Nothing here can make a domain sendable — SES
 * decides that. This answers "what is wrong", which is a question nobody was
 * able to ask.
 *
 * ⚠ AND IT CAN BLAME US, WHICH IS THE POINT. `nameserver_silent` means the
 * customer did their part and our servers are not answering for the zone. That
 * finding is the reason this is worth building: it is invisible from SES, it is
 * indistinguishable from "propagation" at every layer above DNS, and it is not
 * something a customer can ever fix by editing records.
 */

/** One delegated zone's verdict. `zone` is the name they publish NS records at. */
export type ZoneFinding =
  | { zone: string; code: "ok" }
  /** No NS records at the parent yet. The ordinary "still waiting" case. */
  | { zone: string; code: "not_published" }
  /** NS records exist and point at somebody else's nameservers. */
  | { zone: string; code: "delegated_elsewhere"; observed: string[] }
  /**
   * ⚠ NS PUBLISHED TO US AND THE ZONE STILL DOES NOT RESOLVE. A lame
   * delegation: the customer is finished and we are the ones failing.
   */
  | { zone: string; code: "nameserver_silent" }
  /**
   * Delegated to us AND to something else at the same time.
   *
   * ⚠ IT RESOLVES, WHICH IS WHY NOTHING CAUGHT IT. A parent that publishes
   * our two nameservers alongside a third answers `some(ours)` and serves the
   * zone perfectly whenever a resolver happens to pick one of ours — so the
   * domain verifies, mail flows, and then one day a resolver picks the other
   * and it does not. The usual cause is our own: the domain was deleted here,
   * which cannot reach into the customer's zone, and added again with a new
   * claim, so the previous set-up's nameservers are still published beside
   * the current ones.
   *
   * ⚠ AND IT IS REPORTED RATHER THAN REPAIRED, BECAUSE NOBODY HOLDS A
   * CREDENTIAL ON THIS PATH. The publisher clears our leftovers where a
   * provider is connected — see dns/superseded.ts — and this is the same
   * problem for everyone who publishes by hand, where the only thing we can
   * do is name the records and say they must go.
   */
  | {
      zone: string
      code: "extra_nameservers"
      observed: string[]
      unexpected: string[]
    }
  /** The lookup itself failed. Says nothing about the records. */
  | { zone: string; code: "lookup_failed" }

export interface DelegationReport {
  domain: string
  /** Our nameservers, as the customer was told to publish them. */
  nameservers: string[]
  /**
   * ⚠ FALSE MEANS THE DEPLOYMENT IS BROKEN, NOT THE CUSTOMER'S DNS. Checked by
   * asking each configured nameserver directly. When none of them answers,
   * every delegated domain in the system is unverifiable and no record a
   * customer publishes will change that.
   */
  nameserversAnswering: boolean
  zones: ZoneFinding[]
}

export interface DelegationChecker {
  /**
   * @param expected The nameserver names THIS DOMAIN'S records name, which is
   * `<claim>.ns1.i10.tech` and not `ns1.i10.tech`. See the note on the
   * parameter where it is read.
   */
  check(domain: string, expected: readonly string[]): Promise<DelegationReport>
}

/**
 * The four questions this asks of DNS, as a port.
 *
 * ⚠ A SEAM RATHER THAN `node:dns` DIRECTLY, BECAUSE THE INTERESTING PART OF
 * THIS MODULE IS THE CLASSIFICATION AND NOT THE RESOLVING. "NS records exist
 * but point elsewhere" and "NS records point at us and the zone does not
 * resolve" are two lines apart and mean opposite things — one is the customer's
 * to fix and one is ours — and a test that has to stand up a DNS server to tell
 * them apart is a test nobody writes.
 */
export interface DelegationLookups {
  /**
   * What the PARENT publishes as the delegation for `zone`.
   *
   * ⚠ THE PARENT'S REFERRAL, NOT `resolveNs`, AND THE DIFFERENCE IS THE WHOLE
   * ANSWER THIS SCREEN GIVES. A recursive resolver FOLLOWS a delegation and
   * returns the NS records from the zone at the far end — ours — so it reports
   * what we published about ourselves rather than what the customer published
   * about us. Worse, in the state this screen is opened in most often, our zone
   * does not exist yet: the resolver chases the referral to a server that
   * answers REFUSED, returns SERVFAIL, and a perfectly correct delegation is
   * classified `lookup_failed`. `domains/referral.ts` exists for precisely this
   * question and has said so since it was written.
   */
  referralTo(parent: string, zone: string): Promise<ReferralResult>
  /** The zone's own SOA, followed through the delegation. Rejects if unserved. */
  soaOf(zone: string): Promise<void>
  /** Addresses for one of our nameserver hostnames. */
  addressesOf(host: string): Promise<string[]>
  /** Whether a DNS server at `address` responds to anything at all. */
  respondsAt(address: string, name: string): Promise<boolean>
}

export interface DelegationCheckerOptions {
  /*
   * ⚠ THERE IS NO `nameservers` HERE ANY MORE, AND ITS ABSENCE IS THE FIX. A
   * deployment-wide list is the wrong grain for a per-claim delegation: two
   * domains in the same deployment are told to publish different nameserver
   * names, so the set to check against belongs to the domain and arrives with
   * the question. Leaving it here would leave the wrong answer reachable.
   */
  /** Same reasoning as `dnsInspector`: an unbounded lookup blocks a screen. */
  timeoutMs?: number
  /** Overridden only by tests. Production uses the resolver below. */
  lookups?: DelegationLookups
}

const DEFAULT_TIMEOUT = 3000

/** `ns1.i10.tech.` and `NS1.I10.TECH` are the same nameserver. */
const canonical = (host: string) => host.trim().toLowerCase().replace(/\.$/, "")

export function delegationChecker(
  options: DelegationCheckerOptions,
): DelegationChecker {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const dns = options.lookups ?? resolverLookups(timeoutMs)

  return {
    /*
     * ⚠ `expected` IS THIS DOMAIN'S NAMESERVER NAMES, NOT THE DEPLOYMENT'S, AND
     * READING THE DEPLOYMENT'S WAS A BUG THAT SURVIVED A WHOLE REDESIGN. Every
     * delegating customer used to publish the same `ns1.i10.tech`, so matching
     * against `MAIL_NAMESERVERS` was the same question. Per-claim nameservers
     * changed what customers are told to publish to `<claim>.ns1.i10.tech` and
     * this module was not changed with them, so a customer who had followed the
     * instructions exactly was told their records "point at somebody else" —
     * naming, as the somebody else, our own nameserver.
     *
     * ⚠ AND IT COMES FROM THE RECORD LIST THE CUSTOMER IS LOOKING AT rather
     * than being rebuilt here. A second derivation of the same names is a
     * second chance for the table and the check to disagree, and the disagreement
     * is invisible because both look right on their own.
     */
    async check(domain, expected) {
      const names = Object.values(delegatedZoneNames(domain))
      const ours = new Set(expected.map(canonical))

      /*
       * ⚠ THE NAMESERVER CHECK RUNS ALONGSIDE THE ZONE CHECKS, NOT AFTER THEM.
       * It is the finding that reframes all the others — a silent nameserver
       * makes "not published" the least of somebody's problems — so waiting for
       * three zone lookups before starting it would double the time to the
       * answer that matters most.
       */
      const [nameserversAnswering, zones] = await Promise.all([
        answering([...ours], dns),
        Promise.all(names.map((zone) => checkZone(domain, zone, ours))),
      ])

      return {
        domain,
        nameservers: [...ours],
        nameserversAnswering,
        zones,
      }
    },
  }

  async function checkZone(
    parent: string,
    zone: string,
    ours: ReadonlySet<string>,
  ): Promise<ZoneFinding> {
    let referral: ReferralResult
    try {
      referral = await dns.referralTo(parent, zone)
    } catch {
      return { zone, code: "lookup_failed" }
    }

    /*
     * ⚠ "WE COULD NOT ASK" IS NOT AN ANSWER ABOUT THE RECORDS, which is the
     * distinction `referral.ts` keeps and the reason it reports three outcomes
     * rather than two. A parent that timed out must not be reported as a
     * customer who published nothing.
     */
    if (referral.kind === "unreachable") return { zone, code: "lookup_failed" }
    if (referral.kind === "undelegated") return { zone, code: "not_published" }

    const observed = referral.nameservers.map(canonical)
    if (observed.length === 0) return { zone, code: "not_published" }

    // ⚠ `some`, NOT `every`. A customer part-way through publishing has one of
    // our two nameservers in place; that is delegated to us and still resolving,
    // not a misconfiguration to shout about.
    if (!observed.some((ns) => ours.has(ns))) {
      return { zone, code: "delegated_elsewhere", observed }
    }

    /*
     * ⚠ THE SECOND LOOKUP IS WHAT SEPARATES "DELEGATED" FROM "WORKING". The NS
     * records above live in the PARENT zone and are published by the customer,
     * so they prove only that they followed the instructions. Asking for the
     * zone's own SOA follows the delegation to us and fails if we do not
     * answer — which is exactly the state a deployment with no running
     * authoritative server is in, and the state nothing else in this product
     * can see.
     */
    try {
      await dns.soaOf(zone)

      /*
       * ⚠ CHECKED AFTER THE SOA, NOT BEFORE, SO THE WORSE FINDING WINS. A
       * zone that does not resolve at all is our failure and is what somebody
       * needs to hear; extra nameservers beside working ones is a hazard they
       * need to hear about second.
       */
      const unexpected = observed.filter((ns) => !ours.has(ns))
      if (unexpected.length > 0) {
        return { zone, code: "extra_nameservers", observed, unexpected }
      }

      return { zone, code: "ok" }
    } catch {
      /*
       * ⚠ EVERY FAILURE HERE IS OURS, WHICH IS WHY THERE IS NO BRANCH. The
       * customer has published NS records pointing at us; from that point the
       * only things between the question and an answer are our servers. A
       * SERVFAIL is a delegation to something that does not respond, and an
       * NXDOMAIN is our server answering that it does not hold the zone. Both
       * mean the same thing to the person waiting: they are finished, and it
       * is not working because of us.
       */
      return { zone, code: "nameserver_silent" }
    }
  }
}

/**
 * ⚠ ASKED OF EACH NAMESERVER DIRECTLY, WHICH IS THE ONLY WAY TO SEE THIS. A
 * resolver walking the tree hides the difference between "the zone is not
 * delegated" and "the delegation is fine and the target is dead" — both come
 * back as a failure to resolve. Pointing a resolver AT the server and asking it
 * anything at all distinguishes them: a nameserver that is running answers,
 * even if the answer is a refusal.
 *
 * ⚠ THE ADDRESSES COME FROM OUR OWN CONFIGURATION, NEVER FROM A REQUEST. This
 * sets the servers a resolver talks to, which would be a way to make the API
 * speak to an arbitrary host if the input were a customer's. It is
 * `MAIL_NAMESERVERS`.
 */
async function answering(
  nameservers: readonly string[],
  dns: DelegationLookups,
): Promise<boolean> {
  const results = await Promise.all(
    nameservers.map(async (host) => {
      try {
        const addresses = await dns.addressesOf(canonical(host))
        if (addresses.length === 0) return false
        return await dns.respondsAt(addresses[0]!, canonical(host))
      } catch {
        return false
      }
    }),
  )

  // ⚠ ANY ONE OF THEM IS ENOUGH. Resolvers try every nameserver in a delegation
  // before giving up, so one live server serves the zone — badly, with no
  // redundancy, but it serves it. Reporting this as broken would send somebody
  // chasing a resilience problem while their domain verifies perfectly well.
  return results.some(Boolean)
}

/** The production adapter: node's resolver, with a bounded timeout. */
function resolverLookups(timeoutMs: number): DelegationLookups {
  /*
   * ⚠ A DEDICATED `Resolver` PER CALL, NOT THE MODULE-LEVEL `dns.resolveNs` —
   * the same reasoning as `dns.ts`. The module functions share one global
   * resolver whose timeout is process-wide, so setting one here would change
   * behaviour for everything else in the process that resolves a name,
   * including the SMTP client.
   */
  const fresh = (tries = 2) => new Resolver({ timeout: timeoutMs, tries })

  return {
    /*
     * ⚠ THE ONE LOOKUP HERE THAT IS NOT node's RESOLVER, because node's
     * resolver cannot ask this question at all. See the note on the port and
     * the long one at the top of `domains/referral.ts`: the delegation lives in
     * the PARENT's referral, and every recursive resolver hides it by following
     * it. `readDelegation` is the same reader `verify` proves ownership with,
     * so the screen that explains a failure and the check that causes one can
     * no longer disagree about what DNS says.
     */
    referralTo: (parent, zone) => readDelegation(parent, zone, { timeoutMs }),
    soaOf: async (zone) => {
      await fresh().resolveSoa(zone)
    },
    addressesOf: (host) => fresh(1).resolve4(host),
    respondsAt: async (address, name) => {
      const direct = fresh(1)
      /*
       * ⚠ THE ADDRESS IS OURS, FROM `MAIL_NAMESERVERS`, NEVER FROM A REQUEST.
       * This points a resolver at a specific host, which would be a way to make
       * the API speak to an arbitrary address if the input were a customer's.
       */
      direct.setServers([address])

      /*
       * ⚠ THE QUESTION DOES NOT MATTER; BEING ANSWERED AT ALL DOES. A REFUSED
       * or an NXDOMAIN both mean a DNS server is listening, which is the fact
       * in question — only a timeout or a refused connection means nothing is
       * there at all.
       */
      try {
        await direct.resolveSoa(name)
        return true
      } catch (error) {
        return !isTimeout(error)
      }
    },
  }
}

const codeOf = (error: unknown) => (error as { code?: string }).code ?? ""

const isTimeout = (error: unknown) =>
  ["ETIMEOUT", "ETIMEDOUT", "ECONNREFUSED"].includes(codeOf(error))
