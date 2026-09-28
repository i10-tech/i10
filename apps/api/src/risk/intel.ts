import type { Redis } from "ioredis"
import { isHostingNetwork } from "./identity.js"

/**
 * The outside sources the risk engine asks (#170). Each is optional, each
 * fails soft, and none is on the send path.
 *
 * ⚠ LICENCES DECIDED WHICH SOURCES THESE ARE. Spamhaus's free mirrors and
 * Google's Safe Browsing API are non-commercial only; Web Risk is the
 * commercial path (100k lookups a month free). IPinfo Lite is CC BY-SA 4.0 and
 * free for commercial use with attribution. The Tor exit list is public.
 * rdap.org allows ten requests in ten seconds. See docs/decisions/risk.md.
 */
export type Fetch = typeof fetch

const TIMEOUT_MS = 5_000
const timed = (ms = TIMEOUT_MS) => AbortSignal.timeout(ms)

/** Refreshes the Redis set of Tor exit addresses. Returns how many. */
export async function refreshTorExits(
  redis: Redis,
  fetchImpl: Fetch = fetch,
): Promise<number> {
  const res = await fetchImpl("https://check.torproject.org/torbulkexitlist", {
    signal: timed(15_000),
  })
  if (!res.ok) throw new Error(`Tor exit list answered ${res.status}`)
  const ips = (await res.text())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
  if (ips.length === 0) return 0
  // ⚠ BUILT UNDER A TEMPORARY KEY AND RENAMED, so a reader never sees a half
  // list and reads "not Tor" for an exit that simply had not been added yet.
  const tmp = `risk:tor:${Date.now()}`
  for (let i = 0; i < ips.length; i += 1_000)
    await redis.sadd(tmp, ...ips.slice(i, i + 1_000))
  await redis.rename(tmp, "risk:tor")
  await redis.expire("risk:tor", 3 * 3600)
  return ips.length
}

export interface Network {
  asn: number | null
  asName: string | null
  hosting: boolean
}

/** The network behind an IP, from IPinfo Lite. Null when it cannot say. */
export async function ipinfoLookup(
  ip: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<Network | null> {
  const res = await fetchImpl(
    `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`,
    { signal: timed() },
  )
  if (!res.ok) return null
  const body = (await res.json()) as {
    asn?: string
    as_name?: string
    as_domain?: string
    bogon?: boolean
  }
  if (body.bogon) return { asn: null, asName: "bogon", hosting: false }
  const asn = body.asn ? Number.parseInt(body.asn.replace(/^AS/i, ""), 10) : null
  return {
    asn: Number.isFinite(asn) ? asn : null,
    asName: body.as_name ?? null,
    hosting: isHostingNetwork(body.as_name ?? null, body.as_domain ?? null),
  }
}

/**
 * When a registrable domain was registered, from RDAP.
 *
 * `null` means the registry answered without a date or has no RDAP (many
 * ccTLDs) - unknown, which the score treats as neutral. It throws only on a
 * failure worth retrying.
 */
export async function rdapRegistered(
  domain: string,
  fetchImpl: Fetch = fetch,
): Promise<Date | null> {
  const res = await fetchImpl(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    signal: timed(10_000),
    headers: { accept: "application/rdap+json" },
    redirect: "follow",
  })
  if (res.status === 404 || res.status === 400 || res.status === 501) return null
  if (res.status === 429 || res.status >= 500)
    throw new Error(`rdap answered ${res.status}`)
  if (!res.ok) return null
  const body = (await res.json()) as {
    events?: { eventAction?: string; eventDate?: string }[]
  }
  const reg = body.events?.find((e) => e.eventAction === "registration")?.eventDate
  const at = reg ? new Date(reg) : null
  return at && !Number.isNaN(at.getTime()) ? at : null
}

/** Web Risk's threat types for a host, or an empty list when it is clean. */
export async function webRiskLookup(
  host: string,
  key: string,
  fetchImpl: Fetch = fetch,
): Promise<string[]> {
  const params = new URLSearchParams()
  for (const t of ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"])
    params.append("threatTypes", t)
  params.set("uri", `http://${host}/`)
  params.set("key", key)
  const res = await fetchImpl(
    `https://webrisk.googleapis.com/v1/uris:search?${params}`,
    {
      signal: timed(),
    },
  )
  if (!res.ok) throw new Error(`Web Risk answered ${res.status}`)
  const body = (await res.json()) as { threat?: { threatTypes?: string[] } }
  return body.threat?.threatTypes ?? []
}

/**
 * Laya's judgement of one email: the probability it is phishing, a scam or
 * unsolicited bulk mail. See docs/decisions/risk.md for why this is optional.
 */
export async function layaClassify(
  { url, apiKey }: { url: string; apiKey?: string },
  text: string,
  fetchImpl: Fetch = fetch,
): Promise<number | null> {
  const res = await fetchImpl(`${url.replace(/\/$/, "")}/v1/systemone`, {
    method: "POST",
    signal: timed(15_000),
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      state: { body: text.slice(0, 4_000) },
      questions: {
        abusive: {
          type: "noul",
          instructions:
            "Is this email phishing, a scam, malware delivery, or unsolicited bulk mail " +
            "sent to people who did not ask for it?",
        },
      },
    }),
  })
  if (!res.ok) return null
  const body = (await res.json()) as {
    answers?: {
      abusive?: {
        confidence?: number
        probabilities?: Record<string, number>
        choice?: string
      }
    }
  }
  const a = body.answers?.abusive
  if (!a) return null
  const yes = a.probabilities?.yes ?? a.probabilities?.true
  if (typeof yes === "number") return yes
  if (typeof a.confidence === "number") {
    return a.choice === "no" || a.choice === "false" ? 1 - a.confidence : a.confidence
  }
  return null
}
