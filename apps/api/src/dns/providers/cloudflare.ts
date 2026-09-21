import { supersededBy } from "../superseded.js"
import {
  DnsWriteError,
  failureFor,
  type Credential,
  type DesiredRecord,
  type PublishOutcome,
  type RemoteZone,
  type ZoneWriter,
} from "../port.js"
import { DNS_USER_AGENT } from "../user-agent.js"

/**
 * Cloudflare.
 *
 * ⚠ THE ONE TO GET RIGHT FIRST, BECAUSE IT IS MOST OF THE MARKET. It is also
 * the provider i10's own domain uses, so it is the one that can be exercised
 * end to end without waiting for somebody else's account.
 *
 * ⚠ IT HAS A PER-RECORD API, SO THIS IS ADDITIVE AND NEVER A ZONE PUT. The
 * registry does not mark Cloudflare `replacesZone`, and that is the difference
 * between "add a DKIM record" and "delete the customer's MX records". Records
 * are created one at a time and existing ones are matched by name+type+content
 * so a second run changes nothing.
 *
 * ⚠ AND THE TOKEN MAY BE EITHER AN OAUTH ACCESS TOKEN OR A PASTED API TOKEN.
 * Both are `Authorization: Bearer`, which is why one adapter serves both paths —
 * Cloudflare's OAuth is not open to every developer, so the pasted-token route
 * has to keep working regardless of whether the OAuth application is ever
 * approved. See `dns/oauth.ts`.
 */

const API = "https://api.cloudflare.com/client/v4"

interface CloudflareEnvelope<T> {
  success: boolean
  result: T
  errors?: { code: number; message: string }[]
}

const tokenOf = (credential: Credential): string => {
  const token = credential.accessToken ?? credential.token
  if (typeof token !== "string" || token.length === 0) {
    throw new DnsWriteError("unauthorized", "This Cloudflare connection has no token.")
  }
  return token
}

async function call<T>(
  credential: Credential,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  /*
   * ⚠ READ BEFORE THE `try`, AND THAT IS NOT A STYLE CHOICE. `tokenOf` throws
   * `unauthorized` for a credential that has lost its token, and inside the
   * block below that throw is caught by the network handler and re-wrapped as
   * `unavailable` — so a connection that can only be fixed by reconnecting
   * reports itself as a Cloudflare outage, the console says "try again", and
   * trying again produces the identical failure for ever. The port's own note
   * on `DnsWriteFailure` is about exactly this collapse, in the other
   * direction.
   */
  const bearer = tokenOf(credential)

  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        // See dns/user-agent.ts: the default user agent is a bot signature.
        "User-Agent": DNS_USER_AGENT,
        ...(init.headers ?? {}),
      },
      // ⚠ BOUNDED, BECAUSE THIS RUNS INSIDE A REQUEST SOMEBODY IS WAITING ON.
      // An unbounded fetch against a third party turns their bad day into a
      // pile of our held connections.
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new DnsWriteError("unavailable", "Could not reach Cloudflare.", String(error))
  }

  const body = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null

  if (!response.ok || body?.success === false) {
    /*
     * ⚠ CLOUDFLARE'S OWN ERROR TEXT IS CARRIED THROUGH, because it is better
     * than anything we would write. "Zone → DNS → Edit permission required" is
     * a sentence the customer can act on inside a UI we do not control; "the
     * request failed" is not.
     */
    const detail = body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ")
    throw new DnsWriteError(
      failureFor(response.status),
      "Cloudflare refused the request.",
      detail ?? `HTTP ${response.status}`,
    )
  }

  return (body as CloudflareEnvelope<T>).result
}

interface CfZone {
  id: string
  name: string
}

interface CfRecord {
  id: string
  type: string
  name: string
  content: string
  ttl: number
  priority?: number
}

export function cloudflareWriter(): ZoneWriter {
  return {
    async zones(credential) {
      /*
       * ⚠ PAGINATED, AND THE DEFAULT PAGE IS 20. An agency account with sixty
       * zones would silently not find the customer's domain past the first
       * page, and the failure reads as "we cannot see your zone" rather than
       * "we did not look". 50 per page with a bounded walk covers every real
       * account without turning a connect click into fifty requests.
       */
      const found: RemoteZone[] = []
      for (let page = 1; page <= 20; page += 1) {
        const batch = await call<CfZone[]>(
          credential,
          `/zones?per_page=50&page=${page}`,
        )
        found.push(...batch.map((z) => ({ id: z.id, name: z.name.toLowerCase() })))
        if (batch.length < 50) break
      }
      return found
    },

    async publish(credential, zone, records, options = {}) {
      const existing = await listRecords(credential, zone)
      const outcome: PublishOutcome = {
        created: [],
        unchanged: [],
        removed: [],
        superseded: [],
      }

      /*
       * ⚠ CONFLICTS ARE COLLECTED BEFORE ANYTHING IS WRITTEN, so a refusal
       * leaves the zone exactly as it was. Discovering the third record
       * conflicts after creating the first two would leave a half-published
       * delegation — which resolves inconsistently and is worse than either
       * outcome on its own.
       */
      const conflicts = shadowedBy(records, existing)
      if (conflicts.length > 0 && options.replaceConflicts !== true) {
        return { ...outcome, removed: conflicts.map(describe) }
      }

      for (const conflict of conflicts) {
        await call(credential, `/zones/${zone.id}/dns_records/${conflict.id}`, {
          method: "DELETE",
        })
        outcome.removed.push(describe(conflict))
      }

      /*
       * ⚠ OUR OWN LEFTOVERS GO AFTER THE CONFLICT DECISION AND BEFORE THE
       * WRITES. After, because a refusal must leave the zone untouched —
       * tidying up on a call that then declines to publish would delete a
       * working set and put nothing in its place. Before, because creating
       * the new record first is what briefly gives the zone two of them, and
       * a failure between the two steps would leave exactly the state this
       * exists to clear.
       */
      const stale = !options.clearSuperseded
        ? []
        : supersededBy(
            records,
            existing,
            (record) => ({
              name: record.name,
              type: record.type,
              value: record.content,
            }),
            sameValue,
          ).filter((record) => !conflicts.includes(record))

      for (const record of stale) {
        await call(credential, `/zones/${zone.id}/dns_records/${record.id}`, {
          method: "DELETE",
        })
        outcome.superseded!.push({
          ...describe(record),
          reason: `A ${record.type} record we published previously was left at ${record.name}.`,
        })
      }

      const survived = existing.filter(
        (r) => !conflicts.includes(r) && !stale.includes(r),
      )

      for (const record of records) {
        const already = survived.find(
          (r) =>
            r.type === record.type &&
            sameName(r.name, record.name) &&
            sameValue(r.type, r.content, record.value),
        )
        if (already) {
          outcome.unchanged.push(record)
          continue
        }

        await call(credential, `/zones/${zone.id}/dns_records`, {
          method: "POST",
          body: JSON.stringify({
            type: record.type,
            // ⚠ THE FULL NAME, WHICH CLOUDFLARE ACCEPTS AND PREFERS. Sending a
            // relative one works too and is the classic way to create
            // `mail.example.com.example.com` when a caller has already
            // qualified it.
            name: record.name,
            content: record.value,
            ttl: record.ttl,
            ...(record.priority === undefined ? {} : { priority: record.priority }),
            // ⚠ NEVER PROXIED. An orange-clouded record answers with
            // Cloudflare's HTTP addresses instead of the value — which is
            // exactly how `ns1.i10.tech` came to resolve to 104.21.27.97 and
            // serve no DNS at all. It is only meaningful for A/AAAA/CNAME, and
            // sending it for the others is ignored.
            proxied: false,
          }),
        })
        outcome.created.push(record)
      }

      return outcome
    },
  }
}

async function listRecords(
  credential: Credential,
  zone: RemoteZone,
): Promise<CfRecord[]> {
  const found: CfRecord[] = []
  for (let page = 1; page <= 20; page += 1) {
    const batch = await call<CfRecord[]>(
      credential,
      `/zones/${zone.id}/dns_records?per_page=100&page=${page}`,
    )
    found.push(...batch)
    if (batch.length < 100) break
  }
  return found
}

const describe = (record: CfRecord) => ({
  name: record.name,
  type: record.type,
  value: record.content,
  reason: `A ${record.type} record already exists at ${record.name}.`,
})

const sameName = (a: string, b: string) =>
  a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "")

/**
 * ⚠ TXT VALUES ARE COMPARED UNQUOTED. Cloudflare stores a TXT record's content
 * without the surrounding quotes a zone file would carry, and a caller that
 * sends them would create a second record every single run — each one a
 * duplicate of the last, none of them ever matching.
 */
const sameValue = (type: string, stored: string, wanted: string) => {
  const strip = (v: string) => v.trim().replace(/^"(.*)"$/s, "$1")
  if (type === "TXT") return strip(stored) === strip(wanted)
  return (
    stored.toLowerCase().replace(/\.$/, "") === wanted.toLowerCase().replace(/\.$/, "")
  )
}

/**
 * Existing records that a delegation would shadow.
 *
 * ⚠ ONLY AT THE EXACT DELEGATED NAME, AND ONLY WHEN WE ARE PUBLISHING NS THERE.
 * Putting an NS record at `_dmarc.example.com` hands that whole name to another
 * server, so a TXT record left behind in the parent zone is not merely
 * redundant — it is unreachable, and most providers will refuse to hold both.
 * That is the state a customer who already had DMARC configured lands in, and
 * it is why delegation "did nothing" for them.
 *
 * ⚠ IT DOES NOT TOUCH ANYTHING ELSE IN THE ZONE. Not the apex, not a parent, not
 * a record of a different name. The blast radius is the names we are about to
 * take over and nothing beyond them.
 */
function shadowedBy(
  desired: readonly DesiredRecord[],
  existing: readonly CfRecord[],
): CfRecord[] {
  const delegated = new Set(
    desired
      .filter((r) => r.type === "NS")
      .map((r) => r.name.toLowerCase().replace(/\.$/, "")),
  )
  if (delegated.size === 0) return []

  return existing.filter((record) => {
    if (record.type === "NS") return false
    return delegated.has(record.name.toLowerCase().replace(/\.$/, ""))
  })
}
