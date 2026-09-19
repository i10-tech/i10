import { Resolver } from "node:dns/promises"

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
 * ⚠ WHICH IS ALSO WHY A PLAIN RECURSIVE LOOKUP IS ENOUGH. Reading the token out
 * of the NS records instead would mean reading the PARENT's referral — a
 * resolver asked for `mail.example.com NS` follows the delegation and hands
 * back OUR zone's NS records, not the ones the customer published — and that
 * needs an iterative query and a raw DNS client. A name outside the delegation
 * is answered by any resolver, so `resolveTxt` is the whole implementation.
 */

/** The label the challenge lives at, under the customer's own zone. */
export const CHALLENGE_LABEL = "_i10-challenge"

const CHALLENGE_PREFIX = "i10-domain-verification="

export const challengeName = (domain: string) => `${CHALLENGE_LABEL}.${domain}`

export const challengeValue = (token: string) => `${CHALLENGE_PREFIX}${token}`

/**
 * ⚠ `unreachable` IS NOT `absent`, AND FLATTENING THEM REPEATS A MISTAKE THIS
 * CODEBASE HAS ALREADY MADE ONCE. It is the same distinction SES draws between
 * `FAILED` and `TEMPORARY_FAILURE`: a nameserver that timed out is not a
 * customer who published nothing, and telling the second story to the first
 * person sends them to re-check records that are already correct.
 */
export type Ownership =
  { proven: true } | { proven: false; reason: "absent" | "unreachable" }

/** Every TXT record at a name, each already joined from its chunks. */
export type TxtLookup = (name: string) => Promise<string[]>

/**
 * ⚠ THE CHUNKS ARE JOINED WITH NOTHING BETWEEN THEM, which is what the wire
 * format means. A TXT record longer than 255 bytes is carried as several
 * strings that a reader concatenates; `resolveTxt` hands them over unjoined,
 * and joining them with a space — the obvious guess — corrupts every long
 * record. Our tokens are short, but a customer may well have put the challenge
 * beside a long SPF or DKIM record at the same name.
 */
const NOT_PUBLISHED = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"])

/**
 * ⚠ THE SAME BOUND `console/delegation.ts` USES, AND FOR THE SAME REASON: this
 * now sits on the path of a button somebody presses repeatedly, and an
 * unbounded lookup against a slow nameserver holds a request open for the
 * resolver's own default.
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
 * ⚠ COMPARED CASE-INSENSITIVELY AND WITH QUOTES STRIPPED, because the value
 * makes a round trip through somebody else's control panel. The token is hex,
 * so case carries no information to lose — and a provider that stores the value
 * with the quotes the customer pasted would otherwise fail a record that is, to
 * the eye and to every other resolver, correct.
 */
const normalise = (value: string) => value.trim().replace(/^"|"$/g, "").toLowerCase()

export async function proveOwnership(
  lookup: TxtLookup,
  domain: string,
  token: string,
): Promise<Ownership> {
  const wanted = normalise(challengeValue(token))

  let published: string[]
  try {
    published = await lookup(challengeName(domain))
  } catch {
    return { proven: false, reason: "unreachable" }
  }

  // ⚠ ANY record at the name may be the one, not the first. A customer with two
  // workspaces publishes two challenges at the same name, and a domain already
  // carrying an unrelated TXT record there is not a reason to refuse this one.
  return published.some((value) => normalise(value) === wanted)
    ? { proven: true }
    : { proven: false, reason: "absent" }
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
  lookup: TxtLookup,
  row: Provable,
): Promise<Ownership> {
  if (row.delegated) return proveOwnership(lookup, row.name, row.delegationToken)

  /*
   * ⚠ A MANUAL DOMAIN WITH NO KEY YET CANNOT BE PROVED, AND MUST NOT BE TREATED
   * AS PROVEN. The columns are nullable and a row can exist before generation
   * has run; answering "proven" for a domain with nothing published would grant
   * a name on the strength of a null.
   */
  if (!row.dkimSelector || !row.dkimPublicKey) {
    return { proven: false, reason: "absent" }
  }

  return proveDkim(lookup, row.name, row.dkimSelector, row.dkimPublicKey)
}
