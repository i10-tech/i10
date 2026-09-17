import { Resolver } from "node:dns/promises"
import { detectProvider, type DetectionResult } from "@repo/dns-providers"

/**
 * Looking up what a domain's DNS actually says, right now.
 *
 * ⚠ THIS IS NOT DOMAIN VERIFICATION AND MUST NOT BE MISTAKEN FOR IT. SES decides
 * whether a domain is verified, and `DomainStore.verify` asks it. This answers a
 * different and purely advisory question — "who hosts this, and can we see the
 * records yet" — for a person staring at an onboarding screen wondering whether
 * they pasted the TXT record correctly. Treating a positive answer here as
 * verification would let somebody send from a domain SES has never confirmed.
 *
 * ⚠ AND IT IS DELIBERATELY UNAUTHENTICATED AGAINST THE PUBLIC DNS. It resolves
 * whatever name it is given, which is a capability anyone already has with
 * `dig` — with the exception of the internal suffixes, which it refuses
 * outright, because `db.svc.cluster.local` is a question about our network
 * rather than about a customer's domain. See `PRIVATE_SUFFIXES`.
 *
 * ⚠ IT MAKES NO HTTP REQUESTS AT ALL. It speaks DNS to the pod's resolver and
 * nothing else — there is no `fetch` in this module, which is what keeps a
 * "look up the name the customer typed" feature from being a way to reach
 * anything inside the cluster over HTTP. An earlier draft had a DNS-over-HTTPS
 * path here, to dodge the negative-TTL problem described in
 * docs/decisions/console.md §7; it went unused, and an unused outbound fetcher
 * inside the API is a liability rather than a head start.
 */

export interface DnsRecordSnapshot {
  type: "TXT" | "MX" | "CNAME" | "NS"
  name: string
  values: string[]
}

export interface DnsInspection {
  domain: string
  nameservers: string[]
  provider: {
    slug: string
    name: string
    kind: string
    nsDelegation: boolean
    canConnect: boolean
    oauth: boolean
    manualPath?: string
    helpUrl?: string
  } | null
  confidence: DetectionResult["confidence"]
  /** What we can currently see. Advisory — see the note above. */
  records: {
    txt: string[]
    mx: { exchange: string; priority: number }[]
    dmarc: string[]
  }
  /** Set when the lookup failed rather than returning nothing. */
  error?: string
}

export interface DnsInspector {
  inspect(domain: string): Promise<DnsInspection>
}

export interface DnsInspectorOptions {
  /**
   * ⚠ A TIMEOUT IS MANDATORY BECAUSE A DNS LOOKUP OF A NONEXISTENT DOMAIN CAN
   * HANG FOR THE RESOLVER'S FULL RETRY BUDGET. This runs on every keystroke-ish
   * interaction in the onboarding form; a five-second hang there is the whole
   * experience.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT = 3000

export function dnsInspector(options: DnsInspectorOptions = {}): DnsInspector {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT

  /*
   * ⚠ A DEDICATED `Resolver`, NOT THE MODULE-LEVEL `dns.resolveNs`. The module
   * functions share one global resolver whose timeout is process-wide, so
   * setting one here would change behaviour for anything else in the process
   * that resolves a name — including the SMTP client. An instance keeps the
   * setting local.
   */
  function resolver(): Resolver {
    const r = new Resolver({ timeout: timeoutMs, tries: 2 })
    return r
  }

  async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn()
    } catch {
      // ⚠ EVERY LOOKUP HERE FAILS SOFT, INDIVIDUALLY. A domain with NS records
      // and no DMARC record is the normal state of a domain somebody is
      // part-way through setting up — the whole point of the screen. One
      // NXDOMAIN must not take the other four lookups down with it.
      return fallback
    }
  }

  return {
    async inspect(domain) {
      const name = normaliseDomain(domain)
      if (!name) {
        return {
          domain,
          nameservers: [],
          provider: null,
          confidence: "none",
          records: { txt: [], mx: [], dmarc: [] },
          error: "invalid_domain",
        }
      }

      const r = resolver()

      /*
       * ⚠ FOUR LOOKUPS IN PARALLEL, NOT IN SEQUENCE. Each one can take the full
       * timeout, so awaiting them one after another makes the worst case four
       * times the budget on the one screen where somebody is waiting.
       */
      const [ns, txt, mx, dmarc] = await Promise.all([
        safe(() => r.resolveNs(name), [] as string[]),
        safe(() => r.resolveTxt(name), [] as string[][]),
        safe(
          () => r.resolveMx(name),
          [] as { exchange: string; priority: number }[],
        ),
        safe(() => r.resolveTxt(`_dmarc.${name}`), [] as string[][]),
      ])

      const detection = detectProvider(ns)
      const provider = detection.provider

      return {
        domain: name,
        nameservers: detection.nameservers,
        provider: provider
          ? {
              slug: provider.slug,
              name: provider.name,
              kind: provider.kind,
              nsDelegation: provider.nsDelegation,
              /*
               * ⚠ `canConnect` IS NOT `api !== null`. A provider whose API is
               * gated behind an account-size threshold, or which requires our
               * egress IP to be allowlisted in the customer's account, cannot
               * be connected by clicking a button — and offering one produces a
               * failure the customer reads as our bug. Those cases advertise
               * delegation instead, and the console explains why.
               */
              canConnect: Boolean(
                provider.api && !provider.api.eligibility && !provider.api.ipAllowlist,
              ),
              oauth: Boolean(provider.api?.oauth),
              ...(provider.manualPath ? { manualPath: provider.manualPath } : {}),
              ...(provider.helpUrl ? { helpUrl: provider.helpUrl } : {}),
            }
          : null,
        confidence: detection.confidence,
        records: {
          // `resolveTxt` returns each record as an array of strings, because a
          // long TXT value is transmitted in 255-byte chunks that the client is
          // expected to concatenate. Joining with "" is what the RFC says to do
          // — a space would corrupt a long DKIM key.
          txt: txt.map((chunks) => chunks.join("")),
          mx: mx.map((m) => ({ exchange: m.exchange, priority: m.priority })),
          dmarc: dmarc.map((chunks) => chunks.join("")),
        },
      }
    },
  }
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,}$/

/**
 * Suffixes this will not resolve, whatever the caller asks for.
 *
 * ⚠ THESE NAMES DO NOT EXIST IN PUBLIC DNS, SO ASKING FOR ONE IS ONLY EVER A
 * QUESTION ABOUT THE INSIDE OF THE CLUSTER. `foo.svc.cluster.local` resolves
 * through the pod's own resolver to a ClusterIP; `.internal` is what every
 * major cloud hands out for private instances, and `169.254.169.254.in-addr…`
 * and its friends are the metadata service. None of them is a domain a customer
 * could ever own, so refusing them costs nothing and closes the one way this
 * lookup could be used as a reconnaissance tool: type a name, read back the
 * nameservers and the TXT records of something on the private network.
 *
 * ⚠ IT IS A SUFFIX MATCH ON A LABEL BOUNDARY, NOT `includes`. `notlocal.com`
 * and `my-internal.com` are ordinary public domains and must still resolve; a
 * naive substring check would refuse both.
 */
const PRIVATE_SUFFIXES = [
  "local",
  "localhost",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "onion",
  "test",
  "example",
  "invalid",
  "in-addr.arpa",
  "ip6.arpa",
] as const

function isPrivateName(name: string): boolean {
  return PRIVATE_SUFFIXES.some(
    (suffix) => name === suffix || name.endsWith(`.${suffix}`),
  )
}

/**
 * ⚠ THE UNDERSCORE IS ALLOWED, UNLIKE IN `domains/store.ts`. That function
 * validates a domain somebody is CLAIMING, where an underscore is always a
 * mistake. This one is asked about `_dmarc.example.com` and
 * `selector._domainkey.example.com`, which are the record names the product
 * itself issues — rejecting them would make the visibility check refuse to
 * verify the very records it exists to check.
 */
function normaliseDomain(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\.$/, "")
  if (!name || name.includes("/") || name.includes(" ") || name.includes("@")) return null
  // ⚠ REFUSED BEFORE THE SHAPE CHECK PASSES THEM. `db.svc.cluster.local` is a
  // perfectly well-formed hostname; what disqualifies it is that it names
  // something inside our network rather than something a customer owns. See
  // `PRIVATE_SUFFIXES`.
  if (isPrivateName(name)) return null
  return HOSTNAME.test(name) ? name : null
}

export { normaliseDomain as normaliseLookupName }
