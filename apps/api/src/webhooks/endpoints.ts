/**
 * Deciding whether a URL is one we are willing to POST to.
 *
 * ⚠ A CUSTOMER-SUPPLIED URL THAT OUR WORKER FETCHES IS A SERVER-SIDE REQUEST
 * FORGERY BY CONSTRUCTION. The worker sits inside the cluster, so `http://
 * 169.254.169.254/latest/meta-data/`, `http://i10-platform-db.i10-prod.svc/`
 * and `http://localhost:6379` are all reachable from it and none of them are
 * reachable from the customer. Registering one turns our own delivery machinery
 * into a probe of our internal network.
 *
 * ⚠ AND THE MITIGATION HERE IS PARTIAL, WHICH IS WORTH KNOWING RATHER THAN
 * FORGETTING. These checks run on the string. A hostname that resolves to a
 * private address — a customer's own DNS pointing `hooks.example.com` at
 * 10.0.0.1, or a DNS answer that changes between this check and the request —
 * passes. Closing that needs resolution at delivery time with the resolved
 * address pinned for the connection, which is a socket-level change rather than
 * a validation one. Until then: this stops the obvious attempt, an egress
 * policy is what would stop the determined one.
 */

/** Hostnames that are never a customer's endpoint. */
const BLOCKED_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".svc",
  ".svc.cluster.local",
  ".cluster.local",
]

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"])

export type UrlVerdict = { ok: true } | { ok: false; reason: string }

export function checkEndpointUrl(raw: string): UrlVerdict {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: "`url` must be a valid absolute URL." }
  }

  // ⚠ https ONLY. The payload carries a customer's recipient addresses and
  // subject lines, and the signature proves who sent it — not that nobody read
  // it. Over http, both are on the wire in plain text.
  if (url.protocol !== "https:") {
    return { ok: false, reason: "`url` must use https." }
  }

  if (url.username || url.password) {
    return { ok: false, reason: "`url` must not contain credentials." }
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "")

  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "`url` must point at a public host." }
  }

  // ⚠ AN IP LITERAL IS REFUSED WHATEVER ITS RANGE. A public one is legitimate
  // and rare; allowing them means writing a correct private-range check for
  // IPv4, IPv6, IPv4-mapped IPv6 and every decimal, octal and hex spelling of
  // 127.0.0.1 that a URL parser accepts. Refusing the whole class is one line
  // and has no false negatives.
  if (isIpLiteral(host)) {
    return { ok: false, reason: "`url` must use a hostname, not an IP address." }
  }

  // A single label ("intranet") is a host only resolvable inside a network.
  if (!host.includes(".")) {
    return { ok: false, reason: "`url` must use a fully qualified hostname." }
  }

  return { ok: true }
}

function isIpLiteral(host: string): boolean {
  // `new URL` normalises an IPv6 literal to bracketed form and strips them from
  // `hostname`, leaving colons — which no hostname can contain.
  if (host.includes(":")) return true
  // Anything whose last label is entirely numeric cannot be a real TLD, which
  // covers dotted-quad, decimal and octal spellings alike.
  const last = host.split(".").pop() ?? ""
  return /^\d+$/.test(last)
}
