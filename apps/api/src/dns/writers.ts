import type { ZoneWriter } from "./port.js"
import { cloudflareWriter } from "./providers/cloudflare.js"
import { digitalOceanWriter } from "./providers/digitalocean.js"
import { hetznerWriter } from "./providers/hetzner.js"

/**
 * Which providers we can actually write to.
 *
 * ⚠ THE REGISTRY DESCRIBES THIRTY-TWO PROVIDERS WITH AN API; THIS IMPLEMENTS
 * THREE, AND THE GAP IS THE POINT OF HAVING TWO LISTS. `@repo/dns-providers`
 * answers "what is this provider and what would it take" — it is documentation
 * with a type, and it is what tells a customer on Namecheap why we cannot help
 * them. This answers "what can we do today". Collapsing them would mean either
 * claiming a capability for twenty-nine providers we have not written, or
 * deleting the knowledge that makes writing them cheap.
 *
 * ⚠ THE THREE WERE CHOSEN TO COVER THE THREE SHAPES, not by market share alone.
 * Cloudflare: opaque zone ids, absolute record names, OAuth or a pasted token.
 * DigitalOcean: the domain name IS the zone id, relative names, trailing dots
 * that matter, OAuth. Hetzner: a pasted token in a bespoke header, relative
 * names, MX priority folded into the value. A fourth adapter is one file and no
 * change here beyond a line.
 *
 * ⚠ AND A PROVIDER MARKED `replacesZone` IN THE REGISTRY MUST NOT BE ADDED
 * NAIVELY. GoDaddy, Namecheap, Gandi, Dynadot, Enom and OpenSRS all expose only
 * a whole-zone write; an adapter for any of them has to read, merge and write
 * back under a lock, or it deletes the customer's MX records the first time it
 * runs. The registry flags them for exactly this moment.
 */
const WRITERS: Record<string, () => ZoneWriter> = {
  cloudflare: cloudflareWriter,
  digitalocean: digitalOceanWriter,
  hetzner: hetznerWriter,
}

/** `null` when we know the provider but cannot write to it yet. */
export function writerFor(slug: string): ZoneWriter | null {
  const make = WRITERS[slug]
  return make ? make() : null
}

/** The slugs the console may offer a live Connect button for. */
export function connectableProviders(): string[] {
  return Object.keys(WRITERS)
}
