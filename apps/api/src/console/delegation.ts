import { Resolver } from "node:dns/promises"
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
  check(domain: string): Promise<DelegationReport>
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
  /** NS records at `zone`, from the parent. Rejects when there are none. */
  nsOf(zone: string): Promise<string[]>
  /** The zone's own SOA, followed through the delegation. Rejects if unserved. */
  soaOf(zone: string): Promise<void>
  /** Addresses for one of our nameserver hostnames. */
  addressesOf(host: string): Promise<string[]>
  /** Whether a DNS server at `address` responds to anything at all. */
  respondsAt(address: string, name: string): Promise<boolean>
}

export interface DelegationCheckerOptions {
  nameservers: readonly string[]
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
  const ours = new Set(options.nameservers.map(canonical))
  const dns = options.lookups ?? resolverLookups(timeoutMs)

  return {
    async check(domain) {
      const names = Object.values(delegatedZoneNames(domain))

      /*
       * ⚠ THE NAMESERVER CHECK RUNS ALONGSIDE THE ZONE CHECKS, NOT AFTER THEM.
       * It is the finding that reframes all the others — a silent nameserver
       * makes "not published" the least of somebody's problems — so waiting for
       * three zone lookups before starting it would double the time to the
       * answer that matters most.
       */
      const [nameserversAnswering, zones] = await Promise.all([
        answering(options.nameservers, dns),
        Promise.all(names.map((zone) => checkZone(zone))),
      ])

      return {
        domain,
        nameservers: [...ours],
        nameserversAnswering,
        zones,
      }
    },
  }

  async function checkZone(zone: string): Promise<ZoneFinding> {
    let observed: string[]
    try {
      observed = (await dns.nsOf(zone)).map(canonical)
    } catch (error) {
      /*
       * ⚠ NXDOMAIN AND "NO SUCH RECORD" ARE "NOT PUBLISHED YET", WHICH IS THE
       * NORMAL STATE OF A DOMAIN SOMEBODY IS PART-WAY THROUGH. Anything else —
       * SERVFAIL, a timeout — is a failure of the lookup rather than an answer
       * about the records, and must not be reported as though the customer had
       * done something wrong.
       */
      return isMissing(error)
        ? { zone, code: "not_published" }
        : { zone, code: "lookup_failed" }
    }

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
    nsOf: (zone) => fresh().resolveNs(zone),
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

/** NXDOMAIN, or the name exists with no record of that type. */
const isMissing = (error: unknown) =>
  ["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"].includes(codeOf(error))

const isTimeout = (error: unknown) =>
  ["ETIMEOUT", "ETIMEDOUT", "ECONNREFUSED"].includes(codeOf(error))
