import {
  DnsWriteError,
  failureFor,
  relativeName,
  type Credential,
  type DesiredRecord,
  type PublishOutcome,
  type RemoteZone,
  type ZoneWriter,
} from "../port.js"
import { DNS_USER_AGENT } from "../user-agent.js"

/**
 * DigitalOcean.
 *
 * ⚠ THE SECOND SHAPE, AND IT IS HERE TO PROVE THE PORT FITS MORE THAN ONE API.
 * Cloudflare identifies a zone by an opaque id and takes fully qualified record
 * names; DigitalOcean identifies a zone by the domain name itself and takes
 * names RELATIVE to it. An adapter layer that assumed either would have to be
 * rewritten for the first provider that disagreed — which is the second one.
 *
 * ⚠ AND THE OAUTH SCOPES ARE NARROWER THAN A PERSONAL ACCESS TOKEN, which is
 * the reason to prefer the OAuth path here. A pasted DigitalOcean token is
 * account-wide: it can also delete their droplets. `domain:read` and
 * `domain:create` cannot. The registry notes this on the provider.
 */

const API = "https://api.digitalocean.com/v2"

const tokenOf = (credential: Credential): string => {
  const token = credential.accessToken ?? credential.token
  if (typeof token !== "string" || token.length === 0) {
    throw new DnsWriteError(
      "unauthorized",
      "This DigitalOcean connection has no token.",
    )
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
   * reports itself as a DigitalOcean outage, the console says "try again", and
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
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new DnsWriteError(
      "unavailable",
      "Could not reach DigitalOcean.",
      String(error),
    )
  }

  if (response.status === 204) return undefined as T

  const body = (await response.json().catch(() => null)) as
    (T & { message?: string }) | null

  if (!response.ok) {
    throw new DnsWriteError(
      failureFor(response.status),
      "DigitalOcean refused the request.",
      body?.message ?? `HTTP ${response.status}`,
    )
  }

  return body as T
}

interface DoRecord {
  id: number
  type: string
  /** Relative to the zone, or `@`. */
  name: string
  data: string
  ttl: number
  priority: number | null
}

export function digitalOceanWriter(): ZoneWriter {
  return {
    async zones(credential) {
      const found: RemoteZone[] = []
      // ⚠ PAGINATED. DigitalOcean's default page is 20 and an account with more
      // domains than that would simply not find the customer's.
      for (let page = 1; page <= 20; page += 1) {
        const body = await call<{ domains: { name: string }[] }>(
          credential,
          `/domains?per_page=50&page=${page}`,
        )
        const batch = body.domains ?? []
        found.push(...batch.map((d) => ({ id: d.name, name: d.name.toLowerCase() })))
        if (batch.length < 50) break
      }
      return found
    },

    async publish(credential, zone, records, options = {}) {
      const existing = await listRecords(credential, zone)
      const outcome: PublishOutcome = { created: [], unchanged: [], removed: [] }

      // Same ordering rule as every other adapter: decide, then write. A
      // half-published delegation resolves inconsistently.
      const conflicts = shadowedBy(records, existing, zone)
      if (conflicts.length > 0 && options.replaceConflicts !== true) {
        return { ...outcome, removed: conflicts.map((r) => describe(r, zone)) }
      }

      for (const conflict of conflicts) {
        await call(credential, `/domains/${zone.id}/records/${conflict.id}`, {
          method: "DELETE",
        })
        outcome.removed.push(describe(conflict, zone))
      }

      const survived = existing.filter((r) => !conflicts.includes(r))

      for (const record of records) {
        const relative = relativeName(record.name, zone.name)
        const already = survived.find(
          (r) =>
            r.type === record.type &&
            r.name.toLowerCase() === relative.toLowerCase() &&
            sameValue(r.type, r.data, record.value),
        )
        if (already) {
          outcome.unchanged.push(record)
          continue
        }

        await call(credential, `/domains/${zone.id}/records`, {
          method: "POST",
          body: JSON.stringify({
            type: record.type,
            name: relative,
            /*
             * ⚠ A TRAILING DOT ON EVERY HOSTNAME VALUE, AND IT IS NOT OPTIONAL
             * HERE. DigitalOcean treats an unqualified NS, MX or CNAME target as
             * relative to the zone, so `ns1.i10.tech` becomes
             * `ns1.i10.tech.example.com.` — a delegation to a nameserver that
             * does not exist, published successfully, with no error anywhere.
             */
            data: needsTrailingDot(record.type) ? `${record.value}.` : record.value,
            ttl: record.ttl,
            ...(record.priority === undefined ? {} : { priority: record.priority }),
          }),
        })
        outcome.created.push(record)
      }

      return outcome
    },
  }
}

const needsTrailingDot = (type: DesiredRecord["type"]) =>
  type === "NS" || type === "MX" || type === "CNAME"

async function listRecords(
  credential: Credential,
  zone: RemoteZone,
): Promise<DoRecord[]> {
  const found: DoRecord[] = []
  for (let page = 1; page <= 20; page += 1) {
    const body = await call<{ domain_records: DoRecord[] }>(
      credential,
      `/domains/${zone.id}/records?per_page=100&page=${page}`,
    )
    const batch = body.domain_records ?? []
    found.push(...batch)
    if (batch.length < 100) break
  }
  return found
}

const absolute = (record: DoRecord, zone: RemoteZone) =>
  record.name === "@" ? zone.name : `${record.name}.${zone.name}`

const describe = (record: DoRecord, zone: RemoteZone) => ({
  name: absolute(record, zone),
  type: record.type,
  value: record.data,
  reason: `A ${record.type} record already exists at ${absolute(record, zone)}.`,
})

const sameValue = (type: string, stored: string, wanted: string) => {
  const norm = (v: string) =>
    v
      .trim()
      .replace(/^"(.*)"$/s, "$1")
      .replace(/\.$/, "")
  if (type === "TXT") return norm(stored) === norm(wanted)
  return norm(stored).toLowerCase() === norm(wanted).toLowerCase()
}

/** See the long note in the Cloudflare adapter; the rule is identical. */
function shadowedBy(
  desired: readonly DesiredRecord[],
  existing: readonly DoRecord[],
  zone: RemoteZone,
): DoRecord[] {
  const delegated = new Set(
    desired
      .filter((r) => r.type === "NS")
      .map((r) => relativeName(r.name, zone.name).toLowerCase()),
  )
  if (delegated.size === 0) return []

  return existing.filter((record) => {
    if (record.type === "NS") return false
    return delegated.has(record.name.toLowerCase())
  })
}
