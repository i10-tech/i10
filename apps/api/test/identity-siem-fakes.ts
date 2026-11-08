import { createHash, createHmac } from "node:crypto"
import type { StoredEvent } from "../src/identity/ports.js"
import type { SiemRow, SiemSettings, SiemStore } from "../src/identity/siem.js"
import type { OidcFetch } from "../src/identity/oidc-fetch.js"

/** An audit event for the export tests, ids in time order. */
export const event = (n: number, over: Partial<StoredEvent> = {}): StoredEvent => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  type: "sign_in.succeeded",
  actorUserId: null,
  subjectUserId: "user_ada",
  connectionId: null,
  sessionId: null,
  reason: null,
  data: { n },
  createdAt: new Date(Date.UTC(2026, 9, 28, 10, n)),
  ...over,
})

export const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

const rowOf = (s: Memory): SiemRow => ({
  tenantId: s.tenantId,
  endpoint: s.settings.endpoint,
  bucket: s.settings.bucket,
  region: s.settings.region,
  prefix: s.settings.prefix,
  accessKeyId: s.settings.accessKeyId,
  secretHint: SECRET.slice(-4),
  enabled: s.settings.enabled,
  lastEventId: s.cursor,
  lastExportAt: s.lastExportAt,
  lastError: s.lastError,
  lastErrorAt: null,
  nextRunAt: s.nextRunAt,
})

interface Memory {
  tenantId: string
  settings: Omit<SiemSettings, "secretAccessKey">
  cursor: string | null
  lastExportAt: Date | null
  lastError: string | null
  nextRunAt: Date
}

/** SiemStore in memory, with the same claim-by-schedule rule as Postgres. */
export function memorySiem(
  tenantId: string,
  events: StoredEvent[],
  init: Partial<Memory["settings"]> = {},
) {
  const m: Memory = {
    tenantId,
    settings: {
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      bucket: "acme-siem",
      region: "eu-west-1",
      prefix: "logs",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      enabled: true,
      ...init,
    },
    cursor: null,
    lastExportAt: null,
    lastError: null,
    nextRunAt: new Date(0),
  }
  const clock = { now: new Date("2026-10-28T12:00:00Z") }
  const store: SiemStore = {
    get: async () => rowOf(m),
    withSecret: async () => ({ ...rowOf(m), secretAccessKey: SECRET }),
    put: async () => rowOf(m),
    update: async () => rowOf(m),
    remove: async () => true,
    eventsAfter: async (_t, after, limit) =>
      events.filter((e) => after === null || e.id > after).slice(0, limit),
    claim: async (_t, leaseMs) => {
      if (!m.settings.enabled || m.nextRunAt > clock.now) return null
      m.nextRunAt = new Date(clock.now.getTime() + leaseMs)
      return rowOf(m)
    },
    progressed: async (_t, id) => {
      m.cursor = id
      m.lastExportAt = clock.now
      m.lastError = null
    },
    rescheduled: async (_t, ms) => {
      m.nextRunAt = new Date(clock.now.getTime() + ms)
    },
    failed: async (_t, error, ms) => {
      m.lastError = error
      m.nextRunAt = new Date(clock.now.getTime() + ms)
    },
    due: async () => [],
  }
  return { store, state: m, clock }
}

export interface Put {
  url: string
  headers: Record<string, string>
  body: string
}

/** A fetch that records PUTs and answers with `status` (default 200). */
export function memoryBucket(
  answer: (put: Put) => { status: number; body?: string } = () => ({ status: 200 }),
) {
  const puts: Put[] = []
  const fetch: OidcFetch = async (url, options) => {
    const put = {
      url,
      headers: options.headers,
      body: String(options.body ?? ""),
    }
    puts.push(put)
    const r = answer(put)
    return new Response(r.body ?? "", { status: r.status })
  }
  return { fetch, puts }
}

const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest()
const sha = (data: string) => createHash("sha256").update(data).digest("hex")

/**
 * Re-derives the SigV4 signature of a recorded PUT from first principles
 * (the AWS documentation's algorithm, written out here independently of the
 * signer the code uses), and says whether the request's own header matches.
 */
export function signatureHolds(put: Put, secret: string, service = "s3"): boolean {
  const h = Object.fromEntries(
    Object.entries(put.headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  const auth =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      h.authorization ?? "",
    )
  if (!auth) return false
  const [, , date, region, svc, signedHeaders, signature] = auth
  if (svc !== service) return false
  const url = new URL(put.url)
  const names = signedHeaders!.split(";")
  const canonicalHeaders = names
    .map((n) => `${n}:${(n === "host" ? url.host : (h[n] ?? "")).trim()}\n`)
    .join("")
  const payloadHash = h["x-amz-content-sha256"] ?? sha(put.body)
  if (payloadHash !== sha(put.body)) return false
  const canonical = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")
  const stamp = h["x-amz-date"]!
  const scope = `${date}/${region}/${svc}/aws4_request`
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha(canonical)].join("\n")
  const key = hmac(
    hmac(hmac(hmac(`AWS4${secret}`, date!), region!), svc!),
    "aws4_request",
  )
  return hmac(key, toSign).toString("hex") === signature
}
