import { BY_SLUG, PROVIDERS } from "./registry.js"
import type { DetectionResult, DnsProvider } from "./types.js"

/**
 * Turning a domain's nameservers into the name of a company.
 *
 * ⚠ THE MATCH IS A SUFFIX ON A LABEL BOUNDARY, NEVER A SUBSTRING, AND THIS IS A
 * SECURITY PROPERTY RATHER THAN A TIDINESS ONE. `"notcloudflare.com".includes(
 * "cloudflare.com")` is true. Anyone can name their own nameserver, so a
 * substring match lets a third party choose which provider's mark and which
 * "Connect" dialog we show a customer — and that dialog asks them to paste a
 * credential. Requiring the character before the match to be a dot (or the
 * match to be the whole hostname) makes `notcloudflare.com` fail and
 * `gina.ns.cloudflare.com` succeed.
 */
export function matchesPattern(nameserver: string, pattern: string): boolean {
  const host = normaliseNameserver(nameserver)
  const suffix = pattern.toLowerCase()

  if (host === suffix) return true
  if (!host.endsWith(suffix)) return false

  // The character immediately before the suffix must be a label separator.
  return host[host.length - suffix.length - 1] === "."
}

/**
 * ⚠ THE TRAILING DOT IS STRIPPED BECAUSE RESOLVERS DISAGREE ABOUT IT. A fully
 * qualified name from a DNS library is `ns.cloudflare.com.`; the same name from
 * a DoH JSON endpoint usually is not. Comparing them without normalising makes
 * detection work in one deployment and silently fail in another.
 */
export function normaliseNameserver(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "")
}

export function providerFor(nameserver: string): DnsProvider | null {
  const host = normaliseNameserver(nameserver)
  let best: DnsProvider | null = null
  let bestLength = 0

  for (const provider of PROVIDERS) {
    /*
     * ⚠ THE REGEXES ARE TRIED FIRST AND SCORED BY HOW MUCH THEY MATCHED, so
     * they compete with suffix patterns on the same scale rather than always
     * winning. A provider that declares both keeps whichever is more specific
     * for a given hostname.
     */
    for (const pattern of provider.nameserverRegex ?? []) {
      const match = pattern.exec(host)
      if (!match) continue
      if (match[0].length > bestLength) {
        best = provider
        bestLength = match[0].length
      }
    }

    for (const pattern of provider.nameserverPatterns) {
      if (!matchesPattern(nameserver, pattern)) continue
      /*
       * ⚠ LONGEST PATTERN WINS, WHICH IS WHAT RESOLVES THE OVERLAPS. Netlify's
       * zones are served by NS1's infrastructure, so `dns1.p03.nsone.net`
       * matches both `nsone.net` (NS1) and `nsone.net` (Netlify) — the tie is
       * genuine and is broken below. Where one provider's pattern is a strict
       * suffix of another's, the more specific one is the right answer:
       * `ns.cloudflare.com` beats a hypothetical `cloudflare.com`.
       */
      if (pattern.length > bestLength) {
        best = provider
        bestLength = pattern.length
      }
    }
  }

  return best
}

/**
 * The whole answer for one domain's nameserver set.
 *
 * ⚠ `partial` IS A REAL AND COMMON STATE, NOT A ROUNDING ERROR. A domain
 * halfway through a migration answers with two providers' nameservers at once,
 * and so does a zone whose owner added a third-party secondary. Reporting the
 * majority provider with `partial` confidence lets the console say "looks like
 * Cloudflare, but your nameservers are not all pointing there" — which is both
 * true and the single most useful thing it could tell somebody whose records
 * are about to behave unpredictably.
 */
export function detectProvider(nameservers: readonly string[]): DetectionResult {
  const hosts = nameservers.map(normaliseNameserver).filter(Boolean)

  if (hosts.length === 0) {
    return { provider: null, nameservers: [], confidence: "none" }
  }

  const counts = new Map<string, number>()
  for (const host of hosts) {
    const provider = providerFor(host)
    if (!provider) continue
    counts.set(provider.slug, (counts.get(provider.slug) ?? 0) + 1)
  }

  if (counts.size === 0) {
    return { provider: null, nameservers: hosts, confidence: "none" }
  }

  /*
   * ⚠ A WHITE-LABEL BACKEND LOSES TO THE BRAND IT SERVES, AND THIS IS NOT
   * DECORATIVE. NS1 serves Netlify, Wix and Squarespace, so a Netlify zone
   * answers with BOTH `ns01.netlifydns.com` and `dns1.p04.nsone.net` — and
   * whether the branded pattern happens to be longer than `nsone.net` is an
   * accident of spelling, not a rule. Sending a Netlify customer to NS1's
   * dashboard is an answer that is true about their nameservers and useless
   * about where they have to click.
   *
   * The relationship is declared on the backend's own row (`backendFor`), so
   * adding a fourth NS1-hosted brand is a registry edit rather than a change
   * here.
   */
  for (const [slug] of counts) {
    const provider = BY_SLUG.get(slug)
    if (!provider?.isBackend) continue
    // Drop the backend only when one of the brands it serves is also present.
    if ((provider.backendFor ?? []).some((served) => counts.has(served))) {
      counts.delete(slug)
    }
  }

  let winner = ""
  let winnerCount = 0
  for (const [slug, count] of counts) {
    if (count > winnerCount) {
      winner = slug
      winnerCount = count
    }
  }

  /*
   * ⚠ CONFIDENCE ASKS "DO THESE ALL POINT AT ONE PLACE", NOT "WHAT SHARE DID
   * THE WINNER GET", AND THE DIFFERENCE IS THE NETLIFY CASE. A Netlify zone's
   * four nameservers are two branded and two NS1 — the winner accounts for two
   * of four, which by a share calculation is `partial` and is the WRONG answer:
   * all four point at the same infrastructure. Two conditions, both of which
   * have to hold:
   *
   *   1. Every host matched something. One we cannot place means there is a
   *      provider in the set we know nothing about.
   *   2. Exactly one provider survives the backend collapse. Two means the
   *      domain is genuinely split — mid-migration, or a third-party secondary
   *      — and records added at one of them will resolve unpredictably. That is
   *      the single most useful thing the console can warn about here.
   */
  const attributed = hosts.filter((host) => providerFor(host) !== null).length

  return {
    provider: BY_SLUG.get(winner) ?? null,
    nameservers: hosts,
    confidence: attributed === hosts.length && counts.size === 1 ? "exact" : "partial",
  }
}

/** Every provider a person could pick from a list, minus the resolvers. */
export function selectableProviders(): DnsProvider[] {
  return PROVIDERS.filter((p) => p.kind !== "resolver").sort((a, b) =>
    a.name.localeCompare(b.name),
  )
}

/**
 * ⚠ THE RESOLVERS ARE LISTED SEPARATELY RATHER THAN HIDDEN, because somebody
 * WILL look for them. A picker that silently omits Google Public DNS looks
 * broken to the person who came specifically to select it; one that lists it
 * under "these are not DNS hosts" teaches them something in the two seconds
 * they spend reading it.
 */
export function resolverProviders(): DnsProvider[] {
  return PROVIDERS.filter((p) => p.kind === "resolver")
}

export function providerBySlug(slug: string): DnsProvider | null {
  return BY_SLUG.get(slug) ?? null
}
