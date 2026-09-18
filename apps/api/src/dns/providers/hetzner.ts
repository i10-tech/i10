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

/**
 * Hetzner DNS.
 *
 * ⚠ THE THIRD SHAPE: A PASTED TOKEN, NOT AN OAUTH GRANT. It is here so the
 * connect flow is exercised on a provider with no OAuth application to register
 * — which is most of the registry, and all of the providers a small customer
 * actually uses. If every adapter had been an OAuth one, the token path would
 * have gone untested until the first person pasted a key.
 *
 * ⚠ AND THE TOKEN IS FROM THE DNS CONSOLE, NOT HETZNER CLOUD. They are different
 * products with different APIs and non-interchangeable credentials; the registry
 * says so, because a Cloud token pasted here fails in a way that reads exactly
 * like a typo. `zones()` running at connect time is what turns that into a
 * message in the dialog instead of a mystery later.
 */

const API = "https://dns.hetzner.com/api/v1"

const tokenOf = (credential: Credential): string => {
  const token = credential.token ?? credential.accessToken
  if (typeof token !== "string" || token.length === 0) {
    throw new DnsWriteError("unauthorized", "This Hetzner connection has no token.")
  }
  return token
}

async function call<T>(
  credential: Credential,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        // ⚠ THEIR OWN HEADER, NOT `Authorization`. Hetzner DNS reads
        // `Auth-API-Token`; a bearer header is ignored and every call answers
        // 401, which reads as a bad token rather than a wrong header.
        "Auth-API-Token": tokenOf(credential),
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new DnsWriteError("unavailable", "Could not reach Hetzner.", String(error))
  }

  if (response.status === 204 || response.status === 200) {
    const text = await response.text()
    if (text.length === 0) return undefined as T
    return JSON.parse(text) as T
  }

  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string }
  } | null

  if (!response.ok) {
    throw new DnsWriteError(
      failureFor(response.status),
      "Hetzner refused the request.",
      body?.error?.message ?? `HTTP ${response.status}`,
    )
  }

  return body as T
}

interface HetznerRecord {
  id: string
  zone_id: string
  type: string
  /** Relative to the zone, or `@`. */
  name: string
  value: string
  ttl?: number
}

export function hetznerWriter(): ZoneWriter {
  return {
    async zones(credential) {
      const found: RemoteZone[] = []
      for (let page = 1; page <= 20; page += 1) {
        const body = await call<{ zones: { id: string; name: string }[] }>(
          credential,
          `/zones?per_page=100&page=${page}`,
        )
        const batch = body.zones ?? []
        found.push(...batch.map((z) => ({ id: z.id, name: z.name.toLowerCase() })))
        if (batch.length < 100) break
      }
      return found
    },

    async publish(credential, zone, records, options = {}) {
      const body = await call<{ records: HetznerRecord[] }>(
        credential,
        `/records?zone_id=${encodeURIComponent(zone.id)}`,
      )
      const existing = body.records ?? []
      const outcome: PublishOutcome = { created: [], unchanged: [], removed: [] }

      const conflicts = shadowedBy(records, existing, zone)
      if (conflicts.length > 0 && options.replaceConflicts !== true) {
        return { ...outcome, removed: conflicts.map((r) => describe(r, zone)) }
      }

      for (const conflict of conflicts) {
        await call(credential, `/records/${encodeURIComponent(conflict.id)}`, {
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
            sameValue(r.type, r.value, valueFor(record)),
        )
        if (already) {
          outcome.unchanged.push(record)
          continue
        }

        await call(credential, "/records", {
          method: "POST",
          body: JSON.stringify({
            zone_id: zone.id,
            type: record.type,
            name: relative,
            value: valueFor(record),
            ttl: record.ttl,
          }),
        })
        outcome.created.push(record)
      }

      return outcome
    },
  }
}

/**
 * ⚠ HETZNER HAS NO `priority` FIELD; AN MX PRIORITY GOES IN THE VALUE. Sending
 * it as a separate key is silently dropped and produces an MX record with
 * priority 0 — which is valid, deliverable, and not what was asked for.
 *
 * ⚠ AND A HOSTNAME TARGET GETS A TRAILING DOT, for the same reason it does at
 * DigitalOcean: an unqualified target is relative to the zone.
 */
function valueFor(record: DesiredRecord): string {
  if (record.type === "MX") {
    return `${record.priority ?? 10} ${record.value}.`
  }
  if (record.type === "NS" || record.type === "CNAME") return `${record.value}.`
  return record.value
}

const absolute = (record: HetznerRecord, zone: RemoteZone) =>
  record.name === "@" ? zone.name : `${record.name}.${zone.name}`

const describe = (record: HetznerRecord, zone: RemoteZone) => ({
  name: absolute(record, zone),
  type: record.type,
  value: record.value,
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
  existing: readonly HetznerRecord[],
  zone: RemoteZone,
): HetznerRecord[] {
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
