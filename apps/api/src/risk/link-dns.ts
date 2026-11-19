import http2 from "node:http2"
import { parse } from "tldts"
import { decodeMessage, encodeQuery, TYPE_A, type DnsMessage } from "./dns-wire.js"
import {
  CLEAN_ANSWER,
  SKIPPED,
  UNKNOWN,
  type LinkAnswer,
  type LinkProvider,
} from "./link-check.js"
import type { ProviderHealth } from "./provider-health.js"

/**
 * Link checking through the public security DNS resolvers (#222): Cloudflare's
 * malware-blocking resolver and Quad9. Both refuse to resolve a domain they
 * list as malware or phishing; neither needs an account.
 *
 * ⚠ THE HOSTNAME ONLY, NEVER THE URL. Opening a customer's link would consume
 * a magic link or an unsubscribe, and fetching an address an attacker chose is
 * SSRF. The only thing that leaves is a DNS question for a validated name,
 * sent to a fixed resolver.
 *
 * ⚠ A BLOCK AND A NONEXISTENT NAME LOOK ALIKE, SO EVERY BLOCK IS CONFIRMED.
 * Quad9 blocks by answering NXDOMAIN, the same answer as a name that does not
 * exist; the only difference is an empty authority section (docs.quad9.net/FAQs).
 * Cloudflare answers the address 0.0.0.0, which a zone can also publish on its
 * own. So a "looks blocked" answer is never believed alone: the same operator's
 * UNFILTERED resolver is asked, and only a name that resolves there for real is
 * blocked. Anything the pair cannot settle is `unknown`, never `blocked`.
 *
 * ⚠ A PUBLIC FREE SERVICE, SO WE ARE A GOOD GUEST. A UTC-day cap per resolver
 * counts every query before it is sent, Redis down means no queries, an outage
 * parks the resolver for five minutes, and at most a few queries are in flight.
 * Quad9 asks large senders to talk to them first; a few thousand queries a day
 * is far under that.
 */
export const TIMEOUT_MS = 3_000
export const CONCURRENCY = 4
/** A clean answer ages out sooner: a freshly weaponised domain gets listed within hours. */
export const CLEAN_SECONDS = 6 * 3_600
export const BLOCKED_SECONDS = 86_400
export const DOWN_SECONDS = 300
export const HOST_FAIL_SECONDS = 3_600
const MAX_RESPONSE_BYTES = 65_535

export interface DnsRedis {
  get(key: string): Promise<string | null>
  setex(key: string, seconds: number, value: string): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

export type DohTransport = (
  url: string,
  query: Uint8Array,
  signal: AbortSignal,
) => Promise<{ status: number; body: Uint8Array }>

/**
 * RFC 8484 GET over HTTP/2.
 *
 * ⚠ HTTP/2, NOT `fetch`. Quad9 answers HTTP/1.1 with 505 ("requires HTTP/2 in
 * accordance with section 5.2 of the RFC"), and Bun's `fetch` speaks 1.1 only.
 * The customer's host is resolved by the operator, not by the pod's resolver;
 * the pod's resolver is used only to find the two fixed resolver hostnames.
 */
export const h2Doh: DohTransport = (url, query, signal) =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const session = http2.connect(target.origin)
    const fail = (error: unknown) => {
      session.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    if (signal.aborted) return fail(signal.reason)
    signal.addEventListener("abort", () => fail(signal.reason), { once: true })
    session.on("error", fail)
    const request = session.request({
      ":path": `${target.pathname}?dns=${Buffer.from(query).toString("base64url")}`,
      accept: "application/dns-message",
    })
    let status = 0
    let size = 0
    const chunks: Buffer[] = []
    request.on("response", (headers) => {
      status = Number(headers[":status"])
    })
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) return fail(new Error("DNS answer too large"))
      chunks.push(chunk)
    })
    request.on("end", () => {
      session.close()
      resolve({ status, body: new Uint8Array(Buffer.concat(chunks)) })
    })
    request.on("error", fail)
    request.end()
  })

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
/** In the public suffix list, yet never a public website. */
const NEVER_WEBSITES = new Set(["arpa", "onion"])

/**
 * The name to ask about, or null when it is not a public DNS name.
 *
 * ⚠ THE HOST COMES FROM A CUSTOMER'S MAIL. Letters, digits and hyphens in
 * labels of 1-63, at most 253 in all, under a real ICANN suffix: no IP literal,
 * single label, `.local`, `.internal`, `.localhost` or reverse-DNS name, and
 * nothing that is not ASCII (an internationalised name has to arrive already
 * as punycode).
 */
export function dnsLookupName(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, "")
  if (name.length === 0 || name.length > 253) return null
  const labels = name.split(".")
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null
  if (NEVER_WEBSITES.has(labels[labels.length - 1]!)) return null
  const parsed = parse(name)
  return parsed.isIp || !parsed.isIcann || !parsed.domain ? null : name
}

const addresses = (m: DnsMessage) =>
  m.answers.flatMap((a) => (a.address !== null ? [a.address] : []))

export interface Resolver {
  name: "cloudflare" | "quad9"
  /** The resolver that blocks. */
  filtered: string
  /** The same operator's resolver that does not. */
  unfiltered: string
  /** Whether the filtered answer is shaped like this operator's block. */
  looksBlocked(filtered: DnsMessage): boolean
  /** What the unfiltered answer says about a name that looks blocked. */
  confirm(unfiltered: DnsMessage): "blocked" | "not-blocked" | "unclear"
}

/**
 * Cloudflare: a blocked name answers NOERROR with 0.0.0.0
 * (developers.cloudflare.com/1.1.1.1/setup, "1.1.1.1 for Families"). If the
 * real answer is 0.0.0.0 as well, the zone published it and nothing was blocked.
 */
export const CLOUDFLARE: Resolver = {
  name: "cloudflare",
  filtered: "https://security.cloudflare-dns.com/dns-query",
  unfiltered: "https://cloudflare-dns.com/dns-query",
  looksBlocked: (m) => {
    const found = addresses(m)
    return m.rcode === 0 && found.length > 0 && found.every((a) => a === "0.0.0.0")
  },
  confirm: (u) => {
    const found = addresses(u)
    if (u.rcode !== 0 || found.length === 0) return "unclear"
    return found.every((a) => a === "0.0.0.0") ? "not-blocked" : "blocked"
  },
}

/**
 * Quad9: a blocked name answers NXDOMAIN with an EMPTY authority section; a
 * name that does not exist answers NXDOMAIN with the zone's SOA
 * (docs.quad9.net/FAQs, "Identifying a Quad9 block"). Where the unfiltered
 * resolver also says the name does not exist, there was nothing to block and
 * the odd answer cannot be explained: unclear.
 */
export const QUAD9: Resolver = {
  name: "quad9",
  filtered: "https://dns.quad9.net/dns-query",
  unfiltered: "https://dns10.quad9.net/dns-query",
  looksBlocked: (m) => m.rcode === 3 && m.authority === 0,
  confirm: (u) => (u.rcode === 0 && u.answers.length > 0 ? "blocked" : "unclear"),
}

class BudgetSpent extends Error {}

/** `resolver`: the service is the problem, park all of it. `host`: this name is. */
class DohError extends Error {
  constructor(
    message: string,
    readonly scope: "resolver" | "host",
  ) {
    super(message)
  }
}

export function limiter(max: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resume) => waiting.push(resume))
    active++
    try {
      return await run()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

export interface DnsProviderOptions {
  /** Absent: only cached answers are ever returned. */
  redis?: DnsRedis
  /** Queries per resolver per UTC day, every one counted before it is sent. */
  dailyLimit: number
  transport?: DohTransport
  health?: ProviderHealth
  limit?: ReturnType<typeof limiter>
  now?: () => Date
  log?: { warn?: (o: object, m: string) => void }
}

export const dnsKeys = (resolver: string) => ({
  verdict: (host: string) => `risk:link:${resolver}:${host}`,
  fail: (host: string) => `risk:link:${resolver}:fail:${host}`,
  down: `risk:link:${resolver}:down`,
  budget: (now: Date) =>
    `risk:link:${resolver}:budget:${now.toISOString().slice(0, 10)}`,
})

export function dnsProvider(
  resolver: Resolver,
  opts: DnsProviderOptions,
): LinkProvider {
  const { redis, health } = opts
  const keys = dnsKeys(resolver.name)
  const transport = opts.transport ?? h2Doh
  const limit = opts.limit ?? limiter(CONCURRENCY)
  const now = () => opts.now?.() ?? new Date()
  let warnedBudget = ""
  const get = (key: string) =>
    redis?.get(key).catch(() => null) ?? Promise.resolve(null)
  const remember = (key: string, seconds: number, value: string) =>
    redis?.setex(key, seconds, value).catch(() => {})

  const fromCache = (value: string | null): LinkAnswer | null =>
    value === "clean"
      ? CLEAN_ANSWER
      : value === "blocked"
        ? { kind: "unsafe", labels: ["blocked"] }
        : null

  async function ask(url: string, name: string): Promise<DnsMessage> {
    const day = keys.budget(now())
    let used: number
    try {
      used = await redis!.incr(day)
      if (used === 1) await redis!.expire(day, 2 * 86_400)
    } catch {
      throw new BudgetSpent()
    }
    if (used > opts.dailyLimit) {
      if (warnedBudget !== day) {
        warnedBudget = day
        opts.log?.warn?.(
          { resolver: resolver.name, limit: opts.dailyLimit },
          "DNS link-check daily budget spent; lookups resume at midnight UTC",
        )
      }
      throw new BudgetSpent()
    }
    let res: Awaited<ReturnType<DohTransport>>
    try {
      res = await transport(
        url,
        encodeQuery(name, TYPE_A),
        AbortSignal.timeout(TIMEOUT_MS),
      )
    } catch (error) {
      throw new DohError(`unreachable: ${String(error)}`, "resolver")
    }
    // ⚠ ANY NON-200 IS THE SERVICE, not the name: the question is identical in
    // shape every time, so a 4xx is a refusal of us (the Web Risk 403 lesson).
    if (res.status !== 200) throw new DohError(`answered ${res.status}`, "resolver")
    let message: DnsMessage
    try {
      message = decodeMessage(res.body)
    } catch (error) {
      throw new DohError(`unreadable answer: ${String(error)}`, "resolver")
    }
    if (
      message.truncated ||
      message.question?.name !== name ||
      message.question.type !== TYPE_A
    )
      throw new DohError("answer is not to the question asked", "resolver")
    if (message.rcode === 0 || message.rcode === 3) {
      await health?.success(resolver.name)
      return message
    }
    if (message.rcode === 2) {
      // SERVFAIL: the resolver is up, this name did not resolve (a broken DNSSEC chain).
      await health?.success(resolver.name)
      throw new DohError("SERVFAIL", "host")
    }
    throw new DohError(`rcode ${message.rcode}`, "resolver")
  }

  async function check(name: string): Promise<LinkAnswer> {
    const filtered = await ask(resolver.filtered, name)
    if (!resolver.looksBlocked(filtered)) return CLEAN_ANSWER
    const verdict = resolver.confirm(await ask(resolver.unfiltered, name))
    if (verdict === "blocked") return { kind: "unsafe", labels: ["blocked"] }
    return verdict === "not-blocked" ? CLEAN_ANSWER : UNKNOWN
  }

  return {
    name: resolver.name,

    async cached(host) {
      const name = dnsLookupName(host)
      if (!name) return SKIPPED
      return fromCache(await get(keys.verdict(name))) ?? UNKNOWN
    },

    async lookup(host) {
      const name = dnsLookupName(host)
      if (!name) return SKIPPED
      const cached = fromCache(await get(keys.verdict(name)))
      if (cached) return cached
      if (!redis) return UNKNOWN
      if (await get(keys.down)) return UNKNOWN
      if (await get(keys.fail(name))) return UNKNOWN

      try {
        const answer = await limit(() => check(name))
        if (answer.kind === "clean")
          await remember(keys.verdict(name), CLEAN_SECONDS, "clean")
        else if (answer.kind === "unsafe")
          await remember(keys.verdict(name), BLOCKED_SECONDS, "blocked")
        else await remember(keys.fail(name), HOST_FAIL_SECONDS, "unclear")
        return answer
      } catch (error) {
        if (error instanceof BudgetSpent) return UNKNOWN
        if (error instanceof DohError && error.scope === "resolver") {
          await remember(keys.down, DOWN_SECONDS, error.message)
          await health?.failure(resolver.name, error.message)
        } else {
          await remember(keys.fail(name), HOST_FAIL_SECONDS, "failed")
        }
        opts.log?.warn?.(
          { err: error, host: name, resolver: resolver.name },
          "DNS link check failed",
        )
        return UNKNOWN
      }
    },
  }
}

/** Both resolvers, sharing one concurrency limit. */
export function dnsProviders(opts: DnsProviderOptions): LinkProvider[] {
  const limit = opts.limit ?? limiter(CONCURRENCY)
  return [CLOUDFLARE, QUAD9].map((resolver) =>
    dnsProvider(resolver, { ...opts, limit }),
  )
}
