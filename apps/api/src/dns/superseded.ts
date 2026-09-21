import type { DesiredRecord } from "./port.js"

/**
 * Records at our own names, in our own shape, that the set we are about to
 * publish replaces.
 *
 * ⚠ THIS EXISTS BECAUSE DELETING A DOMAIN HERE DOES NOT DELETE ITS RECORDS
 * THERE. Removing a domain from the console tears down the SES identity and
 * the zone we serve; what it cannot touch is what we once wrote into the
 * customer's own DNS. So the customer who deletes `acme.com` and adds it again
 * — with Cloudflare still connected — gets a second full set published beside
 * the first: six NS records at three delegated names, or two `v=DKIM1` TXT
 * records at `i10._domainkey`. Twelve records where six belong.
 *
 * ⚠ AND THE OLD SET IS NOT MERELY UNTIDY, IT BREAKS THE NEW ONE. Two DKIM
 * records at one name is not "one of them wins": resolvers return both, SES
 * signs with the key it was issued and verification fails against whichever
 * answer arrives. Two disjoint NS sets at a delegated name split resolution
 * between our current nameservers and ones that no longer serve that zone, so
 * mail flows or does not depending on which a resolver happened to ask. The
 * domain sits at "pending" with perfect-looking records in front of somebody
 * who has done nothing wrong.
 *
 * ⚠ SO THESE ARE REMOVED WITHOUT ASKING, AND THAT IS A DELIBERATE EXCEPTION TO
 * `replaceConflicts`. That flag guards the CUSTOMER'S records — a DMARC policy
 * they wrote, a TXT their vendor needs — and asking before deleting one is
 * right. These are not theirs. They are ours, at names we are publishing to,
 * in a shape only we produce, superseded by the value we are writing in the
 * same call. Leaving them behind to be "safe" leaves the domain broken.
 *
 * ⚠ AND THE TEST IS DELIBERATELY NARROW, BECAUSE THE COST OF A FALSE POSITIVE
 * IS SOMEBODY ELSE'S MAIL. Every rule below needs all three of: the name is
 * one we are publishing to, the type is one we are publishing there, and the
 * value is recognisably ours as judged AGAINST THE VALUE WE ARE WRITING. A
 * record that fails any of them is left alone and takes the ordinary conflict
 * path, where a human decides.
 */

/** The shape every adapter can produce from its own record type. */
export interface ExistingRecord {
  name: string
  type: string
  value: string
}

const bare = (host: string) => host.trim().toLowerCase().replace(/\.$/, "")

/**
 * ⚠ TXT VALUES ARRIVE QUOTED FROM SOME PROVIDERS AND BARE FROM OTHERS, and the
 * adapters already strip quotes before comparing. This repeats the strip
 * rather than trusting it, because a single stray quote here is the difference
 * between recognising our own DKIM record and deleting nothing.
 */
const txt = (value: string) =>
  value.trim().replace(/^"|"$/g, "").replace(/"\s+"/g, "").toLowerCase()

/**
 * The part of a hostname below its first label — `ns3.i10.tech` → `i10.tech`.
 *
 * ⚠ IT IS THE HOST WE SERVE FROM, AND COMPARING IT IS WHAT LETS A RENAMED
 * NAMESERVER STILL READ AS OURS. `ns1.i10.tech` and `ns3.i10.tech` are the
 * same operator; `ns1.customer-dns.com` is not, and that is the entire
 * distinction being drawn.
 */
function parentOf(host: string): string | null {
  const parts = bare(host).split(".")
  // ⚠ FOUR LABELS MINIMUM BEFORE THIS MEANS ANYTHING. `mail.acme.com` has a
  // parent of `acme.com`, which is the customer's own apex — matching on it
  // would call every record in the zone ours.
  if (parts.length < 3) return null
  return parts.slice(1).join(".")
}

/** MX values are `10 mail.example.com` at some providers and bare at others. */
const exchange = (value: string) => bare(value.replace(/^\d+\s+/, ""))

/**
 * The `include:` tokens in an SPF string.
 *
 * ⚠ THE INCLUDE IS THE SIGNATURE OF AN SPF RECORD WE WROTE. Everything else in
 * `v=spf1 include:spf.i10.tech ~all` is boilerplate shared with every other
 * sender on earth; the include names us specifically.
 */
const includes = (value: string) =>
  new Set(
    txt(value)
      .split(/\s+/)
      .filter((token) => token.startsWith("include:"))
      .map((token) => token.slice("include:".length)),
  )

/**
 * The domains named in a DMARC record's reporting addresses.
 *
 * ⚠ A DMARC RECORD IS THE ONE PLACE WHERE OUR SHAPE AND THE CUSTOMER'S ARE
 * INDISTINGUISHABLE. `v=DMARC1; p=none` is what everybody's looks like, so the
 * prefix proves nothing at all — the only part of ours that names us is where
 * the aggregate reports are sent. Without a shared reporting domain this
 * refuses to call the record ours, which sends it down the conflict path and
 * puts a human in front of the decision. That is the correct answer for a
 * policy somebody may have spent an afternoon on.
 */
const reportDomains = (value: string) =>
  new Set(
    [...txt(value).matchAll(/(?:rua|ruf)=([^;]+)/g)]
      .flatMap((match) => match[1]!.split(","))
      .map((uri) => uri.trim().replace(/^mailto:/, ""))
      .map((address) => address.split("@")[1] ?? "")
      .filter(Boolean),
  )

/**
 * Whether `stored` is a stale copy of something we are writing at this name.
 *
 * `wanted` is every value we are publishing at the same name and type — the
 * caller has already established that none of them equals `stored`.
 */
function ours(type: string, stored: string, wanted: readonly string[]): boolean {
  switch (type) {
    /*
     * ⚠ SAME OPERATOR, DIFFERENT HOST. A delegated name we previously served
     * from `ns1`/`ns2` and now serve from `ns3`/`ns4` leaves the old pair
     * behind, and a resolver that picks one of them gets a zone we no longer
     * publish. The parent-domain test is what recognises the pair as ours
     * without recognising the customer's other nameservers as ours.
     */
    case "NS":
    case "CNAME": {
      const parent = parentOf(stored)
      return parent !== null && wanted.some((value) => parentOf(value) === parent)
    }
    case "MX": {
      const parent = parentOf(exchange(stored))
      return (
        parent !== null && wanted.some((value) => parentOf(exchange(value)) === parent)
      )
    }
    case "TXT": {
      const value = txt(stored)

      /*
       * ⚠ THE NAME IS ALREADY OURS BY CONSTRUCTION, SO THE PREFIX IS ENOUGH.
       * `i10._domainkey.acme.com` is a name only our selector uses; a second
       * `v=DKIM1` at it is a key we issued for a domain row that no longer
       * exists, and it is the single most damaging record in this file to
       * leave behind.
       */
      if (value.startsWith("v=dkim1")) {
        return wanted.some((w) => txt(w).startsWith("v=dkim1"))
      }

      if (value.startsWith("v=spf1")) {
        const mine = includes(stored)
        return wanted.some((w) => [...includes(w)].some((include) => mine.has(include)))
      }

      if (value.startsWith("v=dmarc1")) {
        const mine = reportDomains(stored)
        if (mine.size === 0) return false
        return wanted.some((w) =>
          [...reportDomains(w)].some((domain) => mine.has(domain)),
        )
      }

      // ⚠ EVERY OTHER TXT IS SOMEBODY ELSE'S. Domain verification tokens for
      // Google, Atlassian, Stripe — all of them live at names we may be
      // publishing to, and none of them is ours to remove.
      return false
    }
    default:
      return false
  }
}

/**
 * @param read the adapter's own record, flattened to the three fields this
 *   needs. Cloudflare calls the value `content`, Hetzner and DigitalOcean
 *   disagree about whether a name is absolute — a projection keeps all of
 *   that where it is already handled instead of adding a fourth spelling.
 * @param sameValue the adapter's own value comparison, so "already correct" is
 *   decided by exactly the rule that decides `unchanged` a few lines later. A
 *   second opinion here would let a record count as both stale and present.
 */
export function supersededBy<T>(
  desired: readonly DesiredRecord[],
  existing: readonly T[],
  read: (record: T) => ExistingRecord,
  sameValue: (type: string, stored: string, wanted: string) => boolean,
): T[] {
  if (desired.length === 0) return []

  return existing.filter((entry) => {
    const record = read(entry)
    const wanted = desired.filter(
      (want) => want.type === record.type && bare(want.name) === bare(record.name),
    )
    // Not a name and type we are publishing: out of scope entirely.
    if (wanted.length === 0) return false

    // Already one of the records we want. That is `unchanged`, not stale.
    if (wanted.some((want) => sameValue(record.type, record.value, want.value))) {
      return false
    }

    return ours(
      record.type,
      record.value,
      wanted.map((want) => want.value),
    )
  })
}
