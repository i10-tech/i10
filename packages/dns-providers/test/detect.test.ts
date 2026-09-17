import { describe, expect, test } from "bun:test"
import {
  detectProvider,
  matchesPattern,
  normaliseNameserver,
  providerBySlug,
  providerFor,
  PROVIDERS,
  resolverProviders,
  selectableProviders,
} from "../src/index.js"

/**
 * ⚠ THE FIRST BLOCK IS A SECURITY TEST, NOT A TIDINESS ONE. Anybody can name
 * their own nameserver. If the match were a substring rather than a suffix on a
 * label boundary, a third party could choose which provider's mark and which
 * "Connect" dialog we put in front of a customer — and that dialog asks them to
 * paste a credential that can rewrite their MX records.
 */
describe("matchesPattern", () => {
  test("matches an exact hostname", () => {
    expect(matchesPattern("ns.cloudflare.com", "ns.cloudflare.com")).toBe(true)
  })

  test("matches a subdomain on a label boundary", () => {
    expect(matchesPattern("gina.ns.cloudflare.com", "ns.cloudflare.com")).toBe(true)
    expect(matchesPattern("rick.ns.cloudflare.com", "ns.cloudflare.com")).toBe(true)
  })

  test("refuses a lookalike that only shares a suffix mid-label", () => {
    // The whole point. `"notcloudflare.com".endsWith("cloudflare.com")` is true.
    expect(matchesPattern("notcloudflare.com", "cloudflare.com")).toBe(false)
    expect(matchesPattern("evilcloudflare.com", "cloudflare.com")).toBe(false)
    expect(matchesPattern("xns.cloudflare.com.attacker.net", "ns.cloudflare.com")).toBe(
      false,
    )
  })

  test("refuses a pattern that is longer than the hostname", () => {
    expect(matchesPattern("cloudflare.com", "ns.cloudflare.com")).toBe(false)
  })

  test("is case-insensitive and tolerates a trailing dot", () => {
    // Resolvers disagree about the trailing dot: a DNS library returns
    // `ns.cloudflare.com.` and a DoH JSON endpoint usually does not.
    expect(matchesPattern("GINA.NS.CloudFlare.COM.", "ns.cloudflare.com")).toBe(true)
  })
})

describe("normaliseNameserver", () => {
  test("lowercases and strips the trailing dot", () => {
    expect(normaliseNameserver("  NS1.DigitalOcean.COM. ")).toBe("ns1.digitalocean.com")
  })
})

describe("providerFor", () => {
  test.each([
    ["gina.ns.cloudflare.com", "cloudflare"],
    ["ns-264.awsdns-33.com", "route53"],
    ["ns-1707.awsdns-21.co.uk", "route53"],
    ["ns1.digitalocean.com", "digitalocean"],
    ["ns39.domaincontrol.com", "godaddy"],
    ["dns1.registrar-servers.com", "namecheap"],
    ["pdns1.registrar-servers.com", "namecheap"],
    ["ns-cloud-a1.googledomains.com", "google-cloud-dns"],
    ["ns01.squarespacedns.com", "squarespace"],
    ["ns1.dnsowl.com", "namesilo"],
    ["curitiba.ns.porkbun.com", "porkbun"],
    ["ns1.vercel-dns.com", "vercel"],
    ["ns01.netlifydns.com", "netlify"],
    ["ns1.linode.com", "linode"],
    ["a1-245.akam.net", "akamai-edge-dns"],
    ["hydrogen.ns.hetzner.com", "hetzner"],
    ["ns1-01.azure-dns.com", "azure-dns"],
    ["ns1.alidns.com", "alibaba-dns"],
    ["ns1.dnsimple-edge.net", "dnsimple"],
    ["dns1.name-services.com", "enom"],
    ["ns1.worldnic.com", "network-solutions"],
    ["dns1.easydns.com", "easydns"],
    ["ns1.desec.io", "desec"],
  ])("%s → %s", (nameserver, slug) => {
    expect(providerFor(nameserver)?.slug).toBe(slug)
  })

  test("returns null for something nobody in the registry serves", () => {
    expect(providerFor("ns1.some-tiny-host.example")).toBeNull()
  })

  /**
   * ⚠ AKAMAI SELLS TWO UNRELATED DNS PRODUCTS AND THEY MUST NOT COLLAPSE.
   * Edge DNS is EdgeGrid-signed enterprise; Linode's takes a bearer token. A
   * customer sent to the wrong one cannot authenticate at all.
   */
  test("keeps Akamai Edge DNS separate from Linode", () => {
    expect(providerFor("a7-65.akam.net")?.slug).toBe("akamai-edge-dns")
    expect(providerFor("ns3.linode.com")?.slug).toBe("linode")
  })
})

describe("detectProvider", () => {
  test("reports `exact` when every nameserver agrees", () => {
    const result = detectProvider(["gina.ns.cloudflare.com", "rick.ns.cloudflare.com"])
    expect(result.provider?.slug).toBe("cloudflare")
    expect(result.confidence).toBe("exact")
  })

  /**
   * ⚠ A REAL AND COMMON STATE, NOT A ROUNDING ERROR. A domain part-way through a
   * migration answers with two providers at once, and records added at one of
   * them resolve unpredictably. Reporting the majority WITH `partial` is what
   * lets the console warn about it.
   */
  test("reports `partial` mid-migration", () => {
    const result = detectProvider([
      "gina.ns.cloudflare.com",
      "rick.ns.cloudflare.com",
      "ns-264.awsdns-33.com",
    ])
    expect(result.provider?.slug).toBe("cloudflare")
    expect(result.confidence).toBe("partial")
  })

  /**
   * ⚠ NS1 IS THE BACKEND FOR NETLIFY, WIX AND SQUARESPACE. Without the backend
   * tiebreak, `dns1.p04.nsone.net` would win on pattern length for a large share
   * of Netlify customers and send them to NS1's dashboard — an answer that is
   * true about the nameservers and useless about where to click.
   */
  test("prefers the branded provider over the backend that serves it", () => {
    const result = detectProvider([
      "ns01.netlifydns.com",
      "ns02.netlifydns.com",
      "dns1.p04.nsone.net",
      "dns2.p04.nsone.net",
    ])
    expect(result.provider?.slug).toBe("netlify")
  })

  test("still reports NS1 when nothing else is in the set", () => {
    const result = detectProvider(["dns1.p06.nsone.net", "dns2.p06.nsone.net"])
    expect(result.provider?.slug).toBe("ns1")
  })

  test("reports `none` with the raw nameservers when nothing matches", () => {
    const result = detectProvider(["ns1.unknown.example", "ns2.unknown.example"])
    expect(result.provider).toBeNull()
    expect(result.confidence).toBe("none")
    expect(result.nameservers).toEqual(["ns1.unknown.example", "ns2.unknown.example"])
  })

  test("handles an empty answer", () => {
    expect(detectProvider([]).confidence).toBe("none")
    expect(detectProvider([]).provider).toBeNull()
  })
})

/**
 * ⚠ THE RESOLVERS CAN NEVER BE DETECTED, BY CONSTRUCTION. 8.8.8.8 and 9.9.9.9
 * hold nobody's records and cannot appear in an NS record set. They are in the
 * registry only so a picker can list them and correct the misconception — a
 * "Connect Google Public DNS" button would be offering something that cannot
 * exist.
 */
describe("resolvers", () => {
  test("carry no nameserver patterns", () => {
    for (const provider of resolverProviders()) {
      expect(provider.nameserverPatterns).toHaveLength(0)
      expect(provider.nsDelegation).toBe(false)
      expect(provider.api).toBeNull()
    }
  })

  test("are excluded from the selectable list", () => {
    const slugs = selectableProviders().map((p) => p.slug)
    expect(slugs).not.toContain("google-public-dns")
    expect(slugs).not.toContain("quad9")
  })

  test("are still reachable by slug, so the picker can explain them", () => {
    expect(providerBySlug("quad9")?.kind).toBe("resolver")
    expect(providerBySlug("google-public-dns")?.kind).toBe("resolver")
  })
})

describe("registry integrity", () => {
  test("every slug is unique", () => {
    const slugs = PROVIDERS.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  test("every pattern is lowercase and has no trailing dot", () => {
    for (const provider of PROVIDERS) {
      for (const pattern of provider.nameserverPatterns) {
        expect(pattern).toBe(pattern.toLowerCase())
        expect(pattern.endsWith(".")).toBe(false)
      }
    }
  })

  /**
   * ⚠ A PROVIDER WITH AN OAUTH BLOCK BUT NO `auth: "oauth"` WOULD RENDER A
   * ONE-CLICK BUTTON AND THEN ASK FOR A PASTED TOKEN. The two have to agree.
   */
  test("an oauth block implies the oauth auth method", () => {
    for (const provider of PROVIDERS) {
      if (provider.api?.oauth) expect(provider.api.auth).toBe("oauth")
    }
  })

  /**
   * ⚠ THE DESTRUCTIVE-WRITE FLAG IS THE MOST DANGEROUS FIELD IN THE REGISTRY.
   * This pins the known set so that removing one is a deliberate act with a
   * failing test attached, rather than a quiet edit — an adapter that assumes
   * an additive write against any of these DELETES the customer's MX records.
   */
  test("the providers whose writes replace the whole zone are the known ones", () => {
    const replacing = PROVIDERS.filter((p) => p.api?.replacesZone)
      .map((p) => p.slug)
      .sort()
    expect(replacing).toEqual(["dynadot", "enom", "gandi", "godaddy", "namecheap", "opensrs"])
  })

  test("providers gated by eligibility or an IP allowlist are recorded", () => {
    expect(providerBySlug("godaddy")?.api?.eligibility).toBeTruthy()
    expect(providerBySlug("namecheap")?.api?.eligibility).toBeTruthy()
    expect(providerBySlug("namecheap")?.api?.ipAllowlist).toBe(true)
  })

  /**
   * ⚠ SHOPIFY AND WIX ARE THE TWO WHERE DELEGATION GENUINELY CANNOT BE DONE,
   * and the console disables the option rather than sending somebody hunting
   * for an NS row that is not in the editor.
   */
  test("records the providers whose editor has no NS row", () => {
    expect(providerBySlug("shopify")?.nsDelegation).toBe(false)
    expect(providerBySlug("cloudflare")?.nsDelegation).toBe(true)
  })

  test("Shopify is detected by address records rather than nameservers", () => {
    const shopify = providerBySlug("shopify")
    expect(shopify?.nameserverPatterns).toHaveLength(0)
    expect(shopify?.detect?.apexA).toContain("23.227.38.65")
  })
})

/**
 * ⚠ THESE PIN THE BACKEND COLLAPSE, WHICH IS EASY TO BREAK BY ACCIDENT. Before
 * it existed the Netlify case passed anyway — `netlifydns.com` is simply a
 * longer string than `nsone.net`, so longest-pattern happened to give the right
 * answer. That is an accident of spelling, not a rule, and the first
 * NS1-hosted brand with a short domain would have broken it silently.
 */
describe("white-label backends", () => {
  test("a Netlify zone reads as fully accounted for, not split", () => {
    const result = detectProvider([
      "ns01.netlifydns.com",
      "ns02.netlifydns.com",
      "dns1.p04.nsone.net",
      "dns2.p04.nsone.net",
    ])
    expect(result.provider?.slug).toBe("netlify")
    // Every host is explained and they all point at one place.
    expect(result.confidence).toBe("exact")
  })

  test("the brand wins even when the backend has more nameservers", () => {
    const result = detectProvider([
      "ns01.netlifydns.com",
      "dns1.p04.nsone.net",
      "dns2.p04.nsone.net",
      "dns3.p04.nsone.net",
    ])
    expect(result.provider?.slug).toBe("netlify")
  })

  test("a genuinely split zone still reads as partial", () => {
    const result = detectProvider([
      "gina.ns.cloudflare.com",
      "gina.ns.cloudflare.com",
      "ns-264.awsdns-33.com",
    ])
    expect(result.confidence).toBe("partial")
  })

  test("an unrecognised nameserver in the set makes it partial", () => {
    const result = detectProvider([
      "gina.ns.cloudflare.com",
      "rick.ns.cloudflare.com",
      "ns1.unknown.example",
    ])
    expect(result.provider?.slug).toBe("cloudflare")
    expect(result.confidence).toBe("partial")
  })

  test("every declared backendFor names a provider that exists", () => {
    for (const provider of PROVIDERS) {
      for (const served of provider.backendFor ?? []) {
        expect(providerBySlug(served)).not.toBeNull()
      }
    }
  })
})
