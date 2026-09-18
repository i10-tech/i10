/**
 * Writing records into a zone we do not own.
 *
 * ⚠ THIS IS THE MOST DESTRUCTIVE CAPABILITY IN THE PRODUCT, AND THE PORT IS
 * SHAPED TO MAKE THAT HARD TO FORGET. A credential that can add a TXT record can
 * also rewrite an MX record, and an adapter that gets "publish" slightly wrong
 * does not produce a failed request — it produces a customer whose mail silently
 * stops arriving, days later, for a reason nobody connects to us. Every method
 * below is therefore narrow, and the one that changes anything reports exactly
 * what it changed.
 *
 * ⚠ ADDITIVE AND IDEMPOTENT, NEVER "SYNC THE ZONE". Several providers expose
 * only a whole-zone PUT — `ProviderApi.replacesZone` marks them — and the naive
 * use of one deletes everything the customer had. An adapter for those must
 * read, merge and write back; an adapter for the rest uses the per-record
 * endpoint. Either way `publish` means "make sure these exist", never "make the
 * zone look like this".
 *
 * ⚠ AND IT LIVES IN THE API, NOT IN `@repo/dns-providers`. That package is
 * imported by the browser — the provider picker renders client-side — and it
 * says in its own header that it must keep no runtime dependencies. Adapters do
 * network I/O against a customer's credential; none of that belongs in a
 * bundle a customer downloads.
 */

/** A record as we want it to exist in the customer's zone. */
export interface DesiredRecord {
  /** Fully qualified, no trailing dot. e.g. `mail.example.com`. */
  name: string
  type: "NS" | "TXT" | "MX" | "CNAME" | "A"
  value: string
  ttl: number
  /** MX only. */
  priority?: number
}

/** A record already in the zone that the desired set would shadow or replace. */
export interface ConflictingRecord {
  name: string
  type: string
  value: string
  /**
   * ⚠ WHY IT CONFLICTS, IN WORDS THE CUSTOMER WILL SEE. "There is already a TXT
   * record here" is actionable; "conflict" is not, and this string is rendered.
   */
  reason: string
}

export interface PublishOutcome {
  created: DesiredRecord[]
  /** Already present with the same value. Reported so "nothing happened" is legible. */
  unchanged: DesiredRecord[]
  /**
   * Removed to make room, and ONLY ever when the caller asked for it.
   * See `PublishOptions.replaceConflicts`.
   */
  removed: ConflictingRecord[]
}

export interface PublishOptions {
  /**
   * Whether to delete records that stand in the way.
   *
   * ⚠ FALSE BY DEFAULT, AND THE DEFAULT IS THE WHOLE SAFETY PROPERTY. Delegating
   * `_dmarc.example.com` to us shadows any `_dmarc` TXT record the customer
   * already has — which, for anybody who has ever configured DMARC, is all of
   * them. Removing it is usually right and is never ours to decide silently, so
   * the first call reports the conflicts and refuses, and the console asks.
   */
  replaceConflicts?: boolean
}

/** A zone as the provider knows it. `id` is whatever their API needs. */
export interface RemoteZone {
  id: string
  /** The apex, lowercased, no trailing dot. */
  name: string
}

/**
 * ⚠ THE CREDENTIAL IS OPAQUE JSON, DECIDED PER PROVIDER. Some need one bearer
 * token, some a key and a secret, some an OAuth pair with an expiry. Modelling
 * it as a union here would put every provider's auth shape in one type that
 * every adapter has to narrow; each adapter knows its own and validates it.
 */
export type Credential = Record<string, unknown>

export interface ZoneWriter {
  /**
   * The zones this credential can reach.
   *
   * ⚠ CALLED AT CONNECT TIME, AND THAT IS THE POINT. A credential that parses
   * is not a credential that works: the wrong Hetzner product, a DigitalOcean
   * token without `domain:create`, a Cloudflare token scoped to a zone the
   * customer no longer owns. Listing zones proves reachability before we tell
   * somebody they are connected, so the failure lands in the dialog they are
   * looking at rather than three screens later.
   */
  zones(credential: Credential): Promise<RemoteZone[]>

  /** Makes sure every record exists. Idempotent. See the note on the port. */
  publish(
    credential: Credential,
    zone: RemoteZone,
    records: readonly DesiredRecord[],
    options?: PublishOptions,
  ): Promise<PublishOutcome>
}

/**
 * The provider refused us, and whose fault it is.
 *
 * ⚠ THE DISTINCTION DRIVES WHAT THE CONSOLE SAYS AND IS NOT COSMETIC.
 * `unauthorized` means the customer must reconnect — a revoked token, an expired
 * grant — and nothing else will fix it. `forbidden` means the credential is
 * alive but lacks the scope, which is a different dialog. `unavailable` means
 * retry. Collapsing them sends everybody to reconnect, including the people for
 * whom reconnecting will produce the identical failure.
 */
export type DnsWriteFailure = "unauthorized" | "forbidden" | "not_found" | "unavailable"

export class DnsWriteError extends Error {
  constructor(
    readonly kind: DnsWriteFailure,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = "DnsWriteError"
  }
}

/** Maps an HTTP status onto the failure kinds above. Shared by every adapter. */
export function failureFor(status: number): DnsWriteFailure {
  if (status === 401) return "unauthorized"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  return "unavailable"
}

/**
 * ⚠ THE LONGEST ZONE THAT IS A SUFFIX OF THE RECORD NAME, NOT THE FIRST MATCH.
 * An account can hold both `example.com` and `mail.example.com` as separate
 * zones, and a record at `send.mail.example.com` belongs in the second. Picking
 * the first match writes it into the wrong zone, where it is inert and looks
 * published.
 */
export function zoneFor(
  zones: readonly RemoteZone[],
  recordName: string,
): RemoteZone | null {
  const name = recordName.toLowerCase().replace(/\.$/, "")
  let best: RemoteZone | null = null

  for (const zone of zones) {
    const apex = zone.name.toLowerCase().replace(/\.$/, "")
    // ⚠ A LABEL BOUNDARY, NOT `endsWith`. `notexample.com` ends with
    // `example.com` and is a different domain owned by somebody else.
    if (name !== apex && !name.endsWith(`.${apex}`)) continue
    if (best === null || apex.length > best.name.length) best = zone
  }

  return best
}

/**
 * The record name relative to its zone, which is what most APIs want.
 *
 * ⚠ THE APEX IS `@`, NOT AN EMPTY STRING. Every provider in the registry that
 * takes a relative name uses `@` for the zone apex, and an empty string is
 * accepted by some of them as a literal label — producing a record at
 * `.example.com` that resolves for nobody.
 */
export function relativeName(recordName: string, zoneName: string): string {
  const name = recordName.toLowerCase().replace(/\.$/, "")
  const apex = zoneName.toLowerCase().replace(/\.$/, "")
  if (name === apex) return "@"
  return name.endsWith(`.${apex}`) ? name.slice(0, -(apex.length + 1)) : name
}
