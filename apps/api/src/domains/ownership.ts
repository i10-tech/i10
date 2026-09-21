import { Resolver } from "node:dns/promises"
import { delegatedNameservers, delegatedZoneNames } from "./zone.js"
import type { ReferralResult } from "./referral.js"

/**
 * Proving that the workspace publishing a delegation is the one that asked for
 * it.
 *
 * ⚠ THE DELEGATION RECORDS THEMSELVES CANNOT PROVE THIS, AND THAT IS THE WHOLE
 * REASON THIS FILE EXISTS. Every delegating customer publishes the same two
 * nameservers, so what arrives in DNS is identical whoever produced it. Arrival
 * order was standing in for evidence, and it is not evidence:
 *
 *   1. a stranger adds `example.com`, picks delegation and publishes nothing;
 *   2. the real owner adds `example.com` and publishes the NS records;
 *   3. those records resolve to the STRANGER'S zone, carrying the stranger's
 *      DKIM selector, and SES verifies the stranger.
 *
 * ⚠ AND THE PROOF CANNOT LIVE UNDER THE DELEGATED NAMES. The moment the
 * delegation exists WE answer for `mail.`, `_domainkey.` and `_dmarc.`, so a
 * token in any of them is a token we wrote — it proves our own zone answers,
 * which was never in question. The challenge therefore sits one label to the
 * side, at `_i10-challenge.<domain>`, which is still served by the CUSTOMER'S
 * nameservers and which only somebody holding those nameservers can write.
 *
 * ⚠ AND THE DELEGATED HALF NO LONGER NEEDS AN EXTRA RECORD AT ALL. It used to:
 * every customer published the same two nameservers, so the delegation said
 * that SOMEBODY had delegated the name and nothing about who, and a challenge
 * TXT record beside it carried the identity the delegation could not. Giving
 * each claim its own nameserver hostnames — `<claim>.ns1.i10.tech` — collapses
 * the two into one fact, because only the holder of the domain's DNS can
 * publish it and the label says whose claim it is. Reading it back means
 * reading the PARENT's referral, which is domains/referral.ts.
 */

/**
 * ⚠ `unreachable` IS NOT `absent`, AND FLATTENING THEM REPEATS A MISTAKE THIS
 * CODEBASE HAS ALREADY MADE ONCE. It is the same distinction SES draws between
 * `FAILED` and `TEMPORARY_FAILURE`: a nameserver that timed out is not a
 * customer who published nothing, and telling the second story to the first
 * person sends them to re-check records that are already correct.
 */
export type Ownership =
  | { proven: true }
  /**
   * ⚠ `superseded` IS THE THIRD DISTINCT ANSWER AND IT WAS BEING REPORTED AS
   * `absent`, WHICH IS THE MOST EXPENSIVE WRONG ANSWER THIS CHECK CAN GIVE. A
   * `delegation_token` is generated per ROW, so deleting a domain and adding it
   * again issues a NEW claim — and every NS record the customer already
   * published names the OLD one. Those records resolve, they point at our
   * nameservers, and they look exactly right in their DNS panel. Telling that
   * person their records are missing sends them to re-check DNS that is
   * present, correct, and simply no longer ours to answer for.
   *
   * ⚠ IT IS DETECTED POSITIVELY, not inferred from a failure. The parent must
   * actually be delegating to OUR nameservers under some other claim — anything
   * else is genuinely absent.
   */
  | { proven: false; reason: "absent" | "unreachable" | "superseded" }

/** Every TXT record at a name, each already joined from its chunks. */
export type TxtLookup = (name: string) => Promise<string[]>

/**
 * ⚠ THE CHUNKS ARE JOINED WITH NOTHING BETWEEN THEM, which is what the wire
 * format means. A TXT record longer than 255 bytes is carried as several
 * strings that a reader concatenates; `resolveTxt` hands them over unjoined,
 * and joining them with a space — the obvious guess — corrupts every long
 * record. A 2048-bit DKIM key is always several chunks.
 */
const NOT_PUBLISHED = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"])

/**
 * ⚠ THE SAME BOUND `console/delegation.ts` USES, AND FOR THE SAME REASON: this
 * sits on the path of a button somebody presses repeatedly, and an unbounded
 * lookup against a slow nameserver holds a request open for the resolver's own
 * default.
 */
const DEFAULT_TIMEOUT = 3000

/**
 * ⚠ A DEDICATED `Resolver` PER CALL, NEVER `dns.resolveTxt` — the convention
 * this codebase already holds in `console/delegation.ts` and `console/dns.ts`.
 * The module-level functions share ONE global resolver whose timeout is
 * process-wide, so setting a bound here would quietly change it for everything
 * else that resolves a name in this process, the SMTP client included.
 */
export function nodeTxtLookup(timeoutMs: number = DEFAULT_TIMEOUT): TxtLookup {
  return async (name) => {
    try {
      const answers = await new Resolver({ timeout: timeoutMs, tries: 2 }).resolveTxt(
        name,
      )
      return answers.map((chunks) => chunks.join(""))
    } catch (error) {
      const code = (error as { code?: string }).code
      // ⚠ "NO SUCH NAME" IS AN ANSWER, NOT A FAILURE. It means the customer has
      // not published it yet, which is the ordinary state of every domain
      // between being added and being set up.
      if (code && NOT_PUBLISHED.has(code)) return []
      throw error
    }
  }
}

/**
 * The question asked of a delegated domain.
 *
 * ⚠ IT IS THE `mail.` ZONE THAT IS CHECKED FIRST, because it is the one that
 * carries the return paths and the one a half-finished setup is most likely to
 * have. The other two are tried only when it is absent, so the ordinary success
 * costs ONE query and only a failing domain pays for three — a customer who
 * published two of the three records is told they are proved rather than being
 * sent back to records that are already correct.
 */
export type DelegationProbe = (parent: string, child: string) => Promise<ReferralResult>

export interface DnsProbes {
  /** For a manual domain's DKIM record. */
  txt: TxtLookup
  /** For a delegated domain's NS records, read from the parent. */
  delegation: DelegationProbe
}

/**
 * Proving a DELEGATED domain, from the delegation itself.
 *
 * ⚠ THE COMPARISON IS AGAINST THIS CLAIM'S NAMESERVER NAMES, NOT AGAINST OURS
 * IN GENERAL. `mail.example.com NS ns1.i10.tech` proves that somebody delegated
 * the name to i10 and says nothing about which workspace — which is exactly the
 * hole this design closes. Only `<claim>.ns1.i10.tech` identifies the account,
 * so a bare nameserver name must NOT be accepted, however much it looks like
 * ours.
 *
 * ⚠ AND ONE MATCHING RECORD IS ENOUGH. A zone may legitimately list several
 * nameservers, including ones we did not ask for, and a customer mid-migration
 * may briefly list both an old claim and a new one.
 */
export async function proveDelegation(
  probe: DelegationProbe,
  domain: string,
  claim: string,
  nameservers: readonly string[],
): Promise<Ownership> {
  const wanted = new Set(
    delegatedNameservers(nameservers, claim).map((n) => n.toLowerCase()),
  )
  /*
   * ⚠ THE BARE NAMESERVERS, SO A CLAIM THAT IS NOT OURS CAN STILL BE
   * RECOGNISED AS POINTING AT US. `delegatedNameservers` prefixes each one with
   * the claim; stripping back to the suffix is what lets us tell "delegated to
   * i10 under a different claim" apart from "delegated somewhere else entirely".
   */
  const oursSuffixes = nameservers.map((n) => `.${n.toLowerCase()}`)
  const zones = Object.values(delegatedZoneNames(domain))

  let sawAnswer = false
  let sawOurs = false

  for (const zone of zones) {
    let result: ReferralResult
    try {
      result = await probe(domain, zone)
    } catch {
      return { proven: false, reason: "unreachable" }
    }

    if (result.kind === "unreachable") continue
    sawAnswer = true

    if (result.kind !== "delegated") continue

    if (result.nameservers.some((ns) => wanted.has(ns.toLowerCase()))) {
      return { proven: true }
    }

    // ⚠ POINTED AT US, UNDER SOMEBODY ELSE'S CLAIM — almost always this row's
    // own predecessor, after a delete and re-add issued a fresh token.
    if (
      result.nameservers.some((ns) => {
        const lower = ns.toLowerCase()
        return oursSuffixes.some((suffix) => lower.endsWith(suffix))
      })
    ) {
      sawOurs = true
    }
  }

  /*
   * ⚠ "WE COULD NOT ASK" IS NOT "THEY PUBLISHED NOTHING". If every zone came
   * back unreachable we learned precisely nothing, and reporting that as an
   * absent delegation is what turns a DNS outage into customers losing domains.
   */
  if (sawOurs) return { proven: false, reason: "superseded" }

  return sawAnswer
    ? { proven: false, reason: "absent" }
    : { proven: false, reason: "unreachable" }
}

/** Where a manual domain's DKIM record lives. */
export const dkimName = (selector: string, domain: string) =>
  `${selector}._domainkey.${domain}`

/**
 * What a domain row needs to carry in order to be proved.
 *
 * ⚠ A STRUCTURAL SLICE, NOT THE ROW. The contest path re-proves ANOTHER
 * tenant's domain, which it reads through a SECURITY DEFINER function returning
 * only these fields — so the shape the prover accepts has to be the small one,
 * or the two callers could not share it.
 */
export interface Provable {
  name: string
  delegated: boolean
  delegationToken: string
  dkimSelector: string | null
  dkimPublicKey: string | null
}

/**
 * ⚠ STRIPPED OF QUOTES AND ALL WHITESPACE BEFORE COMPARISON, because this value
 * makes a round trip through somebody else's control panel AND through the DNS
 * wire format. A 2048-bit key does not fit in one 255-byte character-string, so
 * `dkimRecordValue` emits several quoted chunks; resolvers hand them back
 * already split, providers differ on whether they keep the quotes, and several
 * insert whitespace of their own when they re-wrap it. Comparing the raw
 * strings fails for records that are, to every verifier on earth, correct.
 */
const bare = (value: string) => value.replace(/["\s]/g, "")

/**
 * Proving a MANUAL domain, using the record it already publishes.
 *
 * ⚠ IT ASKS FOR NOTHING NEW, WHICH IS WHY MANUAL DOMAINS NEED NO CHALLENGE
 * RECORD. The DKIM selector is generated per DOMAIN ROW — `generateSelector`
 * makes a fresh random one for every create — so `<selector>._domainkey.<domain>`
 * carrying OUR public key is already an account-specific fact that only
 * somebody holding the domain's DNS can publish. It is the same proof the
 * challenge record provides for a delegated domain; a delegated domain simply
 * cannot use it, because that name is inside a zone we serve.
 */
export async function proveDkim(
  lookup: TxtLookup,
  domain: string,
  selector: string,
  publicKey: string,
): Promise<Ownership> {
  let published: string[]
  try {
    published = await lookup(dkimName(selector, domain))
  } catch {
    return { proven: false, reason: "unreachable" }
  }

  const wanted = `p=${bare(publicKey)}`
  return published.some((value) => bare(value).includes(wanted))
    ? { proven: true }
    : { proven: false, reason: "absent" }
}

/**
 * Proving a domain, by whichever route it is set up for.
 *
 * ⚠ ONE ENTRY POINT, BECAUSE EVERY CALLER NEEDS THE SAME ANSWER ABOUT A
 * DIFFERENT KIND OF DOMAIN. `verify` proves the tenant's own; the contest path
 * re-proves an INCUMBENT who may be delegated where the challenger is manual or
 * the other way round. Two functions would mean every caller choosing between
 * them, and the caller that chose wrong would return `absent` for a domain that
 * is perfectly well proved — handing somebody else's live domain away.
 */
export async function proveDomain(
  probes: DnsProbes,
  row: Provable,
  nameservers: readonly string[],
): Promise<Ownership> {
  if (row.delegated) {
    return proveDelegation(
      probes.delegation,
      row.name,
      row.delegationToken,
      nameservers,
    )
  }

  /*
   * ⚠ A MANUAL DOMAIN WITH NO KEY YET CANNOT BE PROVED, AND MUST NOT BE TREATED
   * AS PROVEN. The columns are nullable and a row can exist before generation
   * has run; answering "proven" for a domain with nothing published would grant
   * a name on the strength of a null.
   */
  if (!row.dkimSelector || !row.dkimPublicKey) {
    return { proven: false, reason: "absent" }
  }

  return proveDkim(probes.txt, row.name, row.dkimSelector, row.dkimPublicKey)
}
