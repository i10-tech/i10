import type { AccessDomain, AccessMode, AccessRule } from "@/lib/actions"

/**
 * Which access rule covers an address (#326), for what the Team page SAYS -
 * "auto-join covers them" in the remove dialog.
 *
 * ⚠ DISPLAY ONLY. The API decides who may join, in
 * apps/api/src/console/access-rules.ts, from VERIFIED addresses; this repeats
 * just enough of it (most specific pattern wins, `*.x` is any depth and never
 * `x`) to word a dialog. A difference here mislabels a sentence; it can never
 * let anybody in.
 */

function matches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(`.${pattern.slice(2)}`)
  return host === pattern
}

function specificity(pattern: string): number {
  const wildcard = pattern.startsWith("*.")
  return (
    (wildcard ? pattern.slice(2) : pattern).split(".").length * 2 + (wildcard ? 0 : 1)
  )
}

/** The most specific rule covering an address's domain, among proven domains. */
export function ruleForAddress(
  domains: readonly AccessDomain[],
  email: string,
): AccessRule | null {
  const host = email.split("@")[1]?.trim().toLowerCase() ?? ""
  if (!host) return null
  let best: AccessRule | null = null
  for (const domain of domains) {
    if (domain.status !== "verified") continue
    if (host !== domain.name && !host.endsWith(`.${domain.name}`)) continue
    for (const rule of domain.rules) {
      if (!matches(rule.pattern, host)) continue
      if (!best || specificity(rule.pattern) > specificity(best.pattern)) best = rule
    }
  }
  return best
}

export function modeForAddress(
  domains: readonly AccessDomain[],
  email: string,
): AccessMode {
  return ruleForAddress(domains, email)?.mode ?? "off"
}

/** "@dev.pslhq.app" for an address, as the Team page names how someone joined. */
export function atDomain(email: string): string {
  const host = email.split("@")[1]
  return host ? `@${host}` : email
}
