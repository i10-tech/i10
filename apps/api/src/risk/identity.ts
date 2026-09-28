import { createHmac, timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"
import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { countryDistanceKm } from "./geo.js"

/**
 * What we see of a person (#170): where they sign in from, on what, and when
 * that stops making sense.
 *
 * ⚠ THE CONSOLE CALLS THE API IN-CLUSTER, SO THE API NEVER SEES A PERSON'S IP
 * ON ITS OWN. The console forwards what it saw - the Cloudflare headers of the
 * browser's request, the user agent, and the timezone and device id its page
 * collected - as `x-i10-client`, signed with `CLIENT_CONTEXT_SECRET`. A header
 * anybody could set would let an attacker choose which country they appear to
 * be in; an unsigned or stale one is ignored rather than trusted.
 *
 * ⚠ AND EVERY ROW GOES THROUGH A DEFINER FUNCTION. `core.identity_events` is
 * deny-all under RLS - see its note in db/core.ts.
 */

export const CLIENT_HEADER = "x-i10-client"
/** How old a signed context may be. The console signs per request. */
const MAX_AGE_MS = 5 * 60 * 1000

export interface ClientContext {
  ip?: string
  country?: string
  ua?: string
  tz?: string
  lang?: string
  device?: string
  /** Milliseconds since the epoch, when the console signed it. */
  ts: number
}

export function signClientContext(ctx: ClientContext, secret: string): string {
  const payload = Buffer.from(JSON.stringify(ctx)).toString("base64url")
  const sig = createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${sig}`
}

export function verifyClientContext(
  header: string | null | undefined,
  secret: string | undefined,
  now = Date.now(),
): ClientContext | null {
  if (!header || !secret) return null
  const [payload, sig] = header.split(".")
  if (!payload || !sig) return null
  const want = createHmac("sha256", secret).update(payload).digest()
  let got: Buffer
  try {
    got = Buffer.from(sig, "base64url")
  } catch {
    return null
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  let ctx: ClientContext
  try {
    ctx = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ClientContext
  } catch {
    return null
  }
  if (typeof ctx.ts !== "number" || Math.abs(now - ctx.ts) > MAX_AGE_MS) return null
  if (ctx.ip && !isIP(ctx.ip)) delete ctx.ip
  return ctx
}

/**
 * The network an IP belongs to, for "many accounts from the same place":
 * the /24 for IPv4, the /48 for IPv6.
 */
export function subnetOf(ip: string | null | undefined): string | null {
  if (!ip) return null
  const kind = isIP(ip)
  if (kind === 4) return ip.split(".").slice(0, 3).join(".")
  if (kind === 6) {
    const [head = "", tail = ""] = ip.toLowerCase().split("::")
    const left = head ? head.split(":") : []
    const right = tail ? tail.split(":") : []
    const full = [
      ...left,
      ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
      ...right,
    ]
    return full
      .slice(0, 3)
      .map((h) => h.replace(/^0+(?=.)/, ""))
      .join(":")
  }
  return null
}

export interface Sighting {
  country: string | null
  at: Date
  sessionId: string | null
}

/**
 * Two sightings too far apart for the time between them.
 *
 * ⚠ COUNTRY CENTRES AND AN AIRLINER'S SPEED. Anything under a thousand
 * kilometres is ignored - neighbouring countries, border towns, and the error
 * of using a centre at all - and anything a flight could explain is allowed.
 * A VPN switching exits will still trip this; that is why its first response
 * is to make the person sign in again, not to hold anything.
 */
export function impossibleTravel(
  before: Sighting | null,
  after: Sighting,
): { km: number; hours: number; speedKmh: number } | null {
  if (!before?.country || !after.country || before.country === after.country)
    return null
  const km = countryDistanceKm(before.country, after.country)
  if (km === null || km < 1_000) return null
  const hours = Math.max(0.25, (after.at.getTime() - before.at.getTime()) / 3_600_000)
  const speedKmh = km / hours
  return speedKmh > 900
    ? {
        km: Math.round(km),
        hours: Math.round(hours * 100) / 100,
        speedKmh: Math.round(speedKmh),
      }
    : null
}

/**
 * Whether a network belongs to a hosting provider rather than an ISP.
 *
 * ⚠ A NAME HEURISTIC OVER IPINFO'S AS NAME AND DOMAIN. A real person signs up
 * from a home, an office or a phone; a sign-up from a cloud provider's
 * addresses is a script or a proxy far more often than not. The list is the
 * providers abuse actually comes from, not every datacenter on earth.
 */
const HOSTING = [
  "amazon",
  "aws",
  "google cloud",
  "googleusercontent",
  "microsoft",
  "azure",
  "digitalocean",
  "linode",
  "akamai connected",
  "vultr",
  "choopa",
  "hetzner",
  "ovh",
  "contabo",
  "scaleway",
  "online s.a.s",
  "oracle",
  "alibaba",
  "tencent",
  "leaseweb",
  "m247",
  "datacamp",
  "hostinger",
  "ionos",
  "hostroyale",
  "psychz",
  "servers.com",
  "colocrossing",
  "quadranet",
  "buyvm",
  "frantech",
  "cloudflare",
  "fastly",
  "zenlayer",
  "g-core",
  "gcore",
  "packethub",
  "hosting",
  "datacenter",
  "data center",
  "vps",
  "server",
]
export function isHostingNetwork(
  asName: string | null,
  asDomain: string | null,
): boolean {
  const s = `${asName ?? ""} ${asDomain ?? ""}`.toLowerCase()
  return HOSTING.some((k) => s.includes(k))
}

export interface SightingInput {
  userId: string
  tenantId: string | null
  kind: "session" | "api_key" | "anomaly" | "takeover_response"
  sessionId: string | null
  ip: string | null
  country: string | null
  tor: boolean | null
  userAgent: string | null
  deviceId: string | null
  timezone: string | null
  language: string | null
  detail?: Record<string, unknown> | null
}

export interface IdentityStore {
  record(input: SightingInput): Promise<void>
  lastLocated(userId: string): Promise<Sighting | null>
}

export function identityStore(db: Database): IdentityStore {
  return {
    async record(i) {
      await db.execute(sql`
        select core.record_identity_event(
          ${i.userId}, ${i.tenantId}::uuid, ${i.kind}, ${i.sessionId},
          ${i.ip}, ${subnetOf(i.ip)}, ${i.country}, ${i.tor},
          ${i.userAgent}, ${i.deviceId}, ${i.timezone}, ${i.language},
          ${i.detail ? JSON.stringify(i.detail) : null}::jsonb
        )
      `)
    },
    async lastLocated(userId) {
      const rows = (await db.execute(
        sql`select country, session_id, occurred_at from core.identity_last_located(${userId})`,
      )) as unknown as {
        country: string | null
        session_id: string | null
        occurred_at: string | Date
      }[]
      const r = rows[0]
      return r
        ? { country: r.country, sessionId: r.session_id, at: new Date(r.occurred_at) }
        : null
    },
  }
}

/** The small slice of Redis this module needs. */
export interface RiskRedis {
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number,
    nx: "NX",
  ): Promise<unknown>
  sismember(key: string, member: string): Promise<number>
}

export interface TakeoverResponder {
  /** Signs the person out everywhere and tells them. Idempotent per day. */
  respond(input: {
    userId: string
    tenantId: string | null
    detail: Record<string, unknown>
  }): Promise<void>
}

export interface SightingDeps {
  store: IdentityStore
  redis: RiskRedis
  takeover?: TakeoverResponder
  /** Re-scores the workspace after an anomaly. */
  rescore?: (tenantId: string, trigger: string) => void
  log?: {
    warn?: (o: object, m: string) => void
    error?: (o: object, m: string) => void
  }
  now?: () => Date
}

/**
 * Records one sighting of a person, and reacts when it contradicts the last.
 *
 * ⚠ DEDUPLICATED PER SESSION, PLACE AND DEVICE FOR HALF AN HOUR. The console
 * makes a dozen API calls per page; one row per page load would drown the
 * table and the signal. A change of country inside the window is a new key,
 * so the sighting that matters is never swallowed.
 */
export async function recordSighting(
  input: Omit<SightingInput, "tor" | "kind"> & {
    kind?: SightingInput["kind"]
    /** Cloudflare already said Tor (`T1`); no need to ask the exit list. */
    torHint?: boolean
  },
  deps: SightingDeps,
): Promise<"recorded" | "duplicate" | "anomaly"> {
  const now = deps.now?.() ?? new Date()
  const country = input.country?.toUpperCase() ?? null
  const key = `risk:seen:${input.userId}:${input.sessionId ?? input.ip ?? "-"}:${country ?? "-"}:${input.deviceId ?? "-"}`
  const fresh = await deps.redis.set(key, "1", "EX", 1800, "NX").catch(() => "OK")
  if (fresh === null) return "duplicate"

  const { torHint, ...sighting } = input
  const tor = torHint
    ? true
    : input.ip
      ? await deps.redis
          .sismember("risk:tor", input.ip)
          .then((n) => n === 1)
          .catch(() => null)
      : null
  const before = await deps.store.lastLocated(input.userId).catch(() => null)
  await deps.store.record({ ...sighting, kind: input.kind ?? "session", country, tor })

  const travel = impossibleTravel(before, {
    country,
    at: now,
    sessionId: input.sessionId,
  })
  if (!travel) return "recorded"

  const detail = {
    rule: "impossible_travel",
    from: before?.country,
    to: country,
    ...travel,
  }
  await deps.store.record({
    ...sighting,
    kind: "anomaly",
    country,
    tor,
    detail,
  })
  deps.log?.warn?.({ userId: input.userId, ...detail }, "impossible travel")
  try {
    await deps.takeover?.respond({
      userId: input.userId,
      tenantId: input.tenantId,
      detail,
    })
  } catch (error) {
    deps.log?.error?.({ err: error, userId: input.userId }, "takeover response failed")
  }
  if (input.tenantId) deps.rescore?.(input.tenantId, "identity-anomaly")
  return "anomaly"
}

/**
 * The takeover response (docs/decisions/risk.md): every session of the person
 * revoked, the person emailed, the response recorded.
 *
 * ⚠ EVERY SESSION, INCLUDING THE NEW ONE. We cannot tell which side of an
 * impossible journey is the thief; revoking both makes each re-authenticate,
 * which is where Clerk's second factor and Client Trust stop the one who only
 * has a password.
 */
export function takeoverResponder(deps: {
  clerk: {
    sessions: {
      getSessionList(p: {
        userId: string
        status: "active"
      }): Promise<{ data: { id: string }[] }>
      revokeSession(id: string): Promise<unknown>
    }
  }
  store: IdentityStore
  redis: RiskRedis
  notify?: (userId: string, detail: Record<string, unknown>) => Promise<void>
  enabled: boolean
  log?: {
    warn?: (o: object, m: string) => void
    error?: (o: object, m: string) => void
  }
}): TakeoverResponder {
  return {
    async respond({ userId, tenantId, detail }) {
      if (!deps.enabled) return
      const first = await deps.redis.set(
        `risk:takeover:${userId}`,
        "1",
        "EX",
        86_400,
        "NX",
      )
      if (first === null) return
      const { data } = await deps.clerk.sessions.getSessionList({
        userId,
        status: "active",
      })
      let revoked = 0
      for (const s of data) {
        try {
          await deps.clerk.sessions.revokeSession(s.id)
          revoked++
        } catch (error) {
          deps.log?.error?.({ err: error, userId }, "could not revoke a session")
        }
      }
      await deps.store.record({
        userId,
        tenantId,
        kind: "takeover_response",
        sessionId: null,
        ip: null,
        country: null,
        tor: null,
        userAgent: null,
        deviceId: null,
        timezone: null,
        language: null,
        detail: { ...detail, revoked },
      })
      await deps
        .notify?.(userId, detail)
        .catch((error: unknown) =>
          deps.log?.error?.(
            { err: error, userId },
            "could not email the security notice",
          ),
        )
    },
  }
}
