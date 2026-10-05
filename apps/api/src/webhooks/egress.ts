import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * Where a webhook is allowed to connect, decided at the moment it connects.
 *
 * ⚠ THE CHECK IN `endpoints.ts` READS A STRING; THIS ONE READS THE ANSWER DNS
 * GIVES RIGHT NOW. A customer's own DNS can point `hooks.example.com` at
 * 10.0.0.1, or at a public address when the endpoint is registered and at the
 * metadata service an hour later. The worker sits inside the cluster, so every
 * internal address is one DNS record away from being our delivery machinery
 * probing our own network. The only answer that closes it is to resolve, vet
 * every address, and then connect to the vetted address and nothing else.
 *
 * ⚠ AND THE CONNECTION IS PINNED BY PUTTING THE ADDRESS IN THE URL, NOT BY A
 * LOOKUP HOOK. Under Bun, `fetch` connects to exactly the address in the URL,
 * verifies the certificate against `tls.serverName`, and sends our `Host`
 * header - all three probed against live hosts on 2026-10-05. A `lookup`
 * option on `node:https` could not be shown to be honoured consistently, and a
 * hook that is silently ignored is a pin that is silently absent. A second
 * resolution between our check and the connect is therefore impossible: there
 * is no second resolution.
 *
 * The address ranges are ported from Svix's `is_allowed`
 * (svix/svix-webhooks, server/svix-server/src/core/webhook_http_client.rs,
 * MIT, © 2022 Svix Authors), with additions marked below.
 */

interface Cidr {
  /** The network address as an integer of `width` bits. */
  base: bigint
  prefix: number
  width: 32 | 128
}

function parseV4(ip: string): bigint | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = (n << 8n) | BigInt(v)
  }
  return n
}

function parseV6(ip: string): bigint | null {
  // A zone id ("fe80::1%eth0") names an interface, not part of the address.
  let s = ip.split("%")[0]!.toLowerCase()
  // An embedded dotted quad ("::ffff:1.2.3.4") becomes two hextets.
  const dotted = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) {
    const v4 = parseV4(dotted[1]!)
    if (v4 === null) return null
    s =
      s.slice(0, -dotted[1]!.length) +
      ((v4 >> 16n) & 0xffffn).toString(16) +
      ":" +
      (v4 & 0xffffn).toString(16)
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
    ...tail,
  ]
  let n = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    n = (n << 16n) | BigInt(parseInt(g, 16))
  }
  return n
}

function parseCidr(spec: string): Cidr {
  const [addr, len] = spec.split("/")
  const v4 = parseV4(addr!)
  const width = v4 === null ? 128 : 32
  const base = v4 ?? parseV6(addr!)
  const prefix = len === undefined ? width : Number(len)
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > width) {
    throw new Error(`not a CIDR: ${spec}`)
  }
  return { base, prefix, width }
}

function contains(net: Cidr, addr: bigint, width: 32 | 128): boolean {
  if (net.width !== width) return false
  const shift = BigInt(width - net.prefix)
  return addr >> shift === net.base >> shift
}

const BLOCKED_V4 = [
  "0.0.0.0/8", // "this network", including 0.0.0.0
  "10.0.0.0/8", // RFC 1918
  "100.64.0.0/10", // shared address space (CGNAT)
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, which is where cloud metadata lives
  "172.16.0.0/12", // RFC 1918
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // deprecated 6to4 relay anycast
  "192.168.0.0/16", // RFC 1918
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, including 255.255.255.255
].map(parseCidr)

const BLOCKED_V6 = [
  "::/128", // unspecified
  "::1/128", // loopback
  // ⚠ ADDED, NOT IN SVIX: the deprecated IPv4-compatible form (::a.b.c.d).
  // Nothing legitimate uses it, and some stacks still route it as IPv4.
  "::/96",
  "64:ff9b::/96", // NAT64, which can embed any IPv4 address
  "64:ff9b:1::/48", // local-use NAT64
  "100::/64", // discard
  // ⚠ ADDED, NOT IN SVIX: Teredo tunnels IPv4 inside IPv6.
  "2001::/32",
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4, which embeds an IPv4 address
  "3fff::/20", // documentation
  "5f00::/16", // segment routing (SRv6)
  "fc00::/7", // unique local
  "fe80::/10", // link-local
  "ff00::/8", // multicast
].map(parseCidr)

const MAPPED_V4 = parseCidr("::ffff:0:0/96")

/**
 * Whether an address may be connected to.
 *
 * ⚠ AN IPv4-MAPPED IPv6 ADDRESS IS JUDGED AS THE IPv4 ADDRESS IT CARRIES.
 * `::ffff:127.0.0.1` is loopback; judging it as IPv6 would call it public.
 *
 * `allow` exists for local development and the conformance lab, where the
 * receiver is on a private address by definition. It must never be set in
 * production - see `WEBHOOK_EGRESS_ALLOW`.
 */
export function isPermittedAddress(ip: string, allow: readonly Cidr[] = []): boolean {
  const family = isIP(ip.split("%")[0]!)
  if (family === 4) {
    const n = parseV4(ip)!
    return (
      allow.some((c) => contains(c, n, 32)) ||
      !BLOCKED_V4.some((c) => contains(c, n, 32))
    )
  }
  if (family === 6) {
    const n = parseV6(ip)
    if (n === null) return false
    if (contains(MAPPED_V4, n, 128)) {
      const v4 = n & 0xffffffffn
      return isPermittedAddress(
        [24n, 16n, 8n, 0n].map((s) => String((v4 >> s) & 0xffn)).join("."),
        allow,
      )
    }
    return (
      allow.some((c) => contains(c, n, 128)) ||
      !BLOCKED_V6.some((c) => contains(c, n, 128))
    )
  }
  // Not an address at all. Refusing is the only safe reading.
  return false
}

/** Parses `WEBHOOK_EGRESS_ALLOW`: comma-separated CIDRs, or empty. */
export function parseAllowList(raw: string | undefined): Cidr[] {
  if (!raw?.trim()) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCidr)
}

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export type Lookup = (host: string) => Promise<ResolvedAddress[]>

/** Every address the system resolver returns, in its order. */
export const systemLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }))

export type EgressVerdict =
  | { ok: true; address: string; family: 4 | 6 }
  | {
      ok: false
      /**
       * `blocked`: it resolves somewhere we will not connect to.
       * `unresolved`: DNS had no answer, or did not answer in time.
       */
      kind: "blocked" | "unresolved"
      reason: string
    }

export interface VetOptions {
  lookup?: Lookup
  allow?: readonly Cidr[]
  /** Gives up on DNS when this fires. */
  signal?: AbortSignal
}

/**
 * Resolves a hostname and decides whether, and where, to connect.
 *
 * ⚠ ONE NON-PUBLIC ADDRESS REFUSES THE WHOLE HOST, WHICH IS STRICTER THAN
 * SVIX. Svix drops the bad addresses and connects to whatever is left. An
 * answer that mixes public and private addresses is the shape a rebinding
 * attack takes, not a configuration anybody needs, so it is refused outright.
 *
 * ⚠ IPv4 IS PREFERRED, as Svix does. A cluster without IPv6 egress would
 * otherwise fail every endpoint whose DNS happens to list an AAAA first.
 */
export async function vetHost(
  host: string,
  opts: VetOptions = {},
): Promise<EgressVerdict> {
  // `URL.hostname` keeps the brackets on an IPv6 literal.
  const bare = host.replace(/^\[(.*)\]$/, "$1")
  const allow = opts.allow ?? []

  let addresses: ResolvedAddress[]
  const literal = isIP(bare)
  if (literal) {
    addresses = [{ address: bare, family: literal === 6 ? 6 : 4 }]
  } else {
    try {
      addresses = await abortable((opts.lookup ?? systemLookup)(bare), opts.signal)
    } catch (err) {
      return {
        ok: false,
        kind: "unresolved",
        reason: `${bare} could not be resolved (${err instanceof Error ? err.message : String(err)})`,
      }
    }
  }

  if (addresses.length === 0) {
    return { ok: false, kind: "unresolved", reason: `${bare} has no addresses` }
  }

  const refused = addresses.filter((a) => !isPermittedAddress(a.address, allow))
  if (refused.length > 0) {
    return {
      ok: false,
      kind: "blocked",
      reason: `${bare} resolves to ${refused[0]!.address}, which is not a public address`,
    }
  }

  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0]!
  return { ok: true, address: chosen.address, family: chosen.family }
}

/**
 * The request that reaches the vetted address while still being, to the
 * receiver and its certificate, a request to the hostname the customer gave.
 */
export function pinnedRequest(
  url: URL,
  verdict: { address: string; family: 4 | 6 },
): { url: string; host: string; serverName: string | undefined } {
  const target = new URL(url)
  target.hostname = verdict.family === 6 ? `[${verdict.address}]` : verdict.address
  const bare = url.hostname.replace(/^\[(.*)\]$/, "$1")
  return {
    url: target.toString(),
    // `URL.host` carries the port only when it is not the scheme's default,
    // which is exactly what a Host header should say.
    host: url.host,
    // SNI is a name, never an address; an IP-literal endpoint sends none.
    serverName: url.protocol === "https:" && !isIP(bare) ? bare : undefined,
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
}
