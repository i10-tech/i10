/**
 * The verdict kept for a link host, and how it reads back (#170, #222).
 *
 * A verdict is the string in `core.link_hosts.verdict`: `clean`, or one
 * `provider=labels` segment per provider that flagged the host, joined by `;`
 * (`cloudflare=blocked;quad9=blocked`, `webrisk=MALWARE,SOCIAL_ENGINEERING`).
 *
 * ⚠ A SEGMENT-LESS VERDICT IS WEB RISK'S. Every row written before there was
 * more than one provider is just the threat types (`MALWARE`), and those rows
 * are still inside the seven-day window the score reads. They parse as Web
 * Risk's, so nothing needs migrating.
 *
 * ⚠ PURE ON PURPOSE: rules.ts reads it, and a rule may not reach a network.
 */

/** The names a deployment may list in `RISK_LINK_PROVIDERS`. `dns` is two resolvers. */
export const LINK_PROVIDER_CHOICES = ["dns", "webrisk"] as const
export type LinkProviderChoice = (typeof LINK_PROVIDER_CHOICES)[number]

/** One provider's reason for flagging a host. */
export interface LinkFlag {
  provider: string
  labels: string[]
}

export const CLEAN = "clean"

export function encodeVerdict(flags: readonly LinkFlag[]): string {
  if (flags.length === 0) return CLEAN
  return [...flags]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((f) => `${f.provider}=${f.labels.join(",")}`)
    .join(";")
}

export function parseVerdict(verdict: string): LinkFlag[] {
  if (verdict === CLEAN || verdict === "") return []
  if (!verdict.includes("="))
    return [{ provider: "webrisk", labels: verdict.split(",") }]
  return verdict
    .split(";")
    .map((segment) => {
      const at = segment.indexOf("=")
      return {
        provider: segment.slice(0, at),
        labels: segment.slice(at + 1).split(","),
      }
    })
    .filter((f) => f.provider !== "")
}

/**
 * Whether the flags alone justify the critical floor: Web Risk is a curated
 * commercial list and stands alone; any other provider is one list's opinion,
 * and two independent ones agreeing is what makes it a fact.
 *
 * ⚠ ONE LIST'S FALSE POSITIVE MUST NOT HOLD A CUSTOMER'S MAIL BY ITSELF.
 */
export function isDecisive(flags: readonly LinkFlag[]): boolean {
  return (
    flags.some((f) => f.provider === "webrisk") ||
    new Set(flags.map((f) => f.provider)).size >= 2
  )
}

/** `cloudflare: blocked, quad9: blocked` - the evidence staff read. */
export const describeFlags = (flags: readonly LinkFlag[]): string =>
  flags.map((f) => `${f.provider}: ${f.labels.join("+")}`).join(", ")
