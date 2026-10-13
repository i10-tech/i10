import type { JoinRule } from "../db/core.js"

/**
 * Team access rules (#326), pure: which names may be access domains, which
 * patterns a domain may carry, and which rule an address falls under.
 *
 * ⚠ PURE, SO EVERY RULE OF MATCHING IS TESTED WITHOUT A DATABASE. The store
 * reads rows and the routes check permissions; neither decides whether
 * `a@x.dev.pslhq.app` is covered by `*.pslhq.app` - this file does, and the
 * console's remove dialog repeats only the display half of it.
 */

export type JoinMode = JoinRule["mode"]

/**
 * Mailbox providers whose addresses say nothing about who somebody works for.
 *
 * ⚠ NEVER AN ACCESS DOMAIN, WHATEVER PROOF IS OFFERED. Auto-join on
 * `gmail.com` would add a few billion strangers to a workspace, and nobody
 * can prove it anyway - except a provider's own staff, who do not need us.
 * The list errs long: refusing a real company that happens to be on it costs
 * an email to support; missing a provider costs a workspace.
 */
export const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "passport.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "aim.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "tutanota.com",
  "tuta.io",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "email.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "yandex.ru",
  "ya.ru",
  "mail.ru",
  "inbox.ru",
  "list.ru",
  "bk.ru",
  "rambler.ru",
  "qq.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "duck.com",
  "hushmail.com",
  "mailfence.com",
  "posteo.de",
  "laposte.net",
  "orange.fr",
  "free.fr",
  "wanadoo.fr",
  "libero.it",
  "virgilio.it",
  "t-online.de",
  "seznam.cz",
  "wp.pl",
  "o2.pl",
  "interia.pl",
  "rediffmail.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "btinternet.com",
  "sky.com",
  "shaw.ca",
  "rogers.com",
  "bigpond.com",
  "optusnet.com.au",
])

/**
 * Country variants of the big providers: `hotmail.co.uk`, `yahoo.fr`,
 * `outlook.de` and the rest, matched by their first label.
 */
const FREE_MAIL_BRANDS = new Set([
  "gmail",
  "hotmail",
  "outlook",
  "live",
  "yahoo",
  "gmx",
])

/** Lowercased, trimmed, without a trailing dot. */
export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "")
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** A real hostname of at least two labels: `pslhq.app`, never `app` or `*`. */
export function isHostname(name: string): boolean {
  if (name.length > 253) return false
  const labels = name.split(".")
  return labels.length >= 2 && labels.every((l) => LABEL.test(l))
}

/**
 * Whether a name is, or sits under, a free-mail provider - or would cover one.
 *
 * ⚠ ALL THREE DIRECTIONS. `gmail.com` itself; `x.gmail.com` beneath it; and
 * a parent such as `com.au`, which no workspace can prove but which would
 * cover `optusnet.com.au` if one ever did.
 */
export function isFreeMail(raw: string): boolean {
  const name = normalizeName(raw)
  const labels = name.split(".")
  if (labels.length >= 2 && FREE_MAIL_BRANDS.has(labels[0]!)) {
    // gmail.com, hotmail.co.uk, yahoo.fr - a brand at the registrable level.
    const rest = labels.slice(1)
    if (rest.length <= 2 && rest.every((l) => l.length <= 3)) return true
  }
  for (const free of FREE_MAIL) {
    if (name === free || name.endsWith(`.${free}`) || free.endsWith(`.${name}`)) {
      return true
    }
  }
  return false
}

/** Whether `name` is `domain` or beneath it. Never a parent. */
export function within(name: string, domain: string): boolean {
  return name === domain || name.endsWith(`.${domain}`)
}

/**
 * Every name a seeker's address could be covered by: the domain and each of
 * its parents down to two labels. `a.dev.pslhq.app` gives itself,
 * `dev.pslhq.app` and `pslhq.app`.
 *
 * ⚠ WHAT `app.seeker_domains` IS SET TO. An access domain is the proven name
 * and its rules reach below it, so a seeker at a subdomain has to be able to
 * read the row of the parent that proved it - and only rows that are their
 * own domain or one of its parents, which is all this list can name.
 */
export function coveringNames(domain: string): string[] {
  const labels = normalizeName(domain).split(".")
  const out: string[] = []
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."))
  return out
}

/**
 * Checks one pattern against the access domain it belongs to.
 *
 * ⚠ A PATTERN NEVER REACHES ABOVE ITS DOMAIN. `pslhq.app` proven covers
 * `pslhq.app`, `dev.pslhq.app` and `*.pslhq.app`; a pattern for `other.app`
 * or for the parent of a proven subdomain is refused, because nothing proved
 * it.
 */
export function patternProblem(raw: string, domain: string): string | null {
  const pattern = normalizeName(raw)
  const wildcard = pattern.startsWith("*.")
  const base = wildcard ? pattern.slice(2) : pattern
  if (!isHostname(base)) return `${raw} is not a domain or *.domain pattern.`
  if (!within(base, domain)) return `${raw} is not ${domain} or one of its subdomains.`
  return null
}

/** Valid rules, normalized, one per pattern; or the first problem. */
export function cleanRules(
  rules: unknown,
  domain: string,
): { ok: true; rules: JoinRule[] } | { ok: false; error: string } {
  if (!Array.isArray(rules)) return { ok: false, error: "`rules` must be a list." }
  if (rules.length > 50) return { ok: false, error: "At most 50 rules per domain." }
  const seen = new Set<string>()
  const out: JoinRule[] = []
  for (const raw of rules as unknown[]) {
    const r = raw as Partial<JoinRule> | null
    if (!r || typeof r.pattern !== "string")
      return { ok: false, error: "Each rule needs a pattern." }
    const problem = patternProblem(r.pattern, domain)
    if (problem) return { ok: false, error: problem }
    if (r.mode !== "off" && r.mode !== "suggest" && r.mode !== "auto")
      return { ok: false, error: "A rule's mode is off, suggest or auto." }
    const role = typeof r.role === "string" && r.role.trim() ? r.role.trim() : ""
    if (!/^org:[a-z0-9_:-]{1,64}$/.test(role))
      return { ok: false, error: "A rule needs a role." }
    const pattern = normalizeName(r.pattern)
    if (seen.has(pattern)) return { ok: false, error: `${pattern} is listed twice.` }
    seen.add(pattern)
    out.push({ pattern, mode: r.mode, role })
  }
  return { ok: true, rules: out }
}

/** Whether a pattern covers an address's domain. `*.x` is any depth, never `x`. */
export function patternMatches(pattern: string, domain: string): boolean {
  const name = normalizeName(domain)
  if (pattern.startsWith("*.")) return name.endsWith(`.${pattern.slice(2)}`)
  return name === pattern
}

/**
 * How specific a pattern is: an exact name beats a wildcard at the same
 * level, and a deeper name beats a shallower one.
 *
 *   dev.pslhq.app (7) > *.dev.pslhq.app (6) > pslhq.app (5) > *.pslhq.app (4)
 */
export function specificity(pattern: string): number {
  const wildcard = pattern.startsWith("*.")
  const labels = (wildcard ? pattern.slice(2) : pattern).split(".").length
  return labels * 2 + (wildcard ? 0 : 1)
}

/** The most specific rule covering this domain, or null. */
export function ruleFor(rules: readonly JoinRule[], domain: string): JoinRule | null {
  let best: JoinRule | null = null
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, domain)) continue
    if (!best || specificity(rule.pattern) > specificity(best.pattern)) best = rule
  }
  return best
}

/** An access domain as the matcher needs it. */
export interface AccessDomain {
  tenantId: string
  clerkOrgId: string
  name: string
  rules: readonly JoinRule[]
}

/** What one workspace offers one person. */
export interface Match {
  tenantId: string
  clerkOrgId: string
  /** Their verified address the rule matched. */
  email: string
  pattern: string
  mode: Exclude<JoinMode, "off">
  role: string
}

const STRENGTH: Record<JoinMode, number> = { off: 0, suggest: 1, auto: 2 }

/**
 * What each workspace offers a person, from their VERIFIED addresses only.
 *
 * ⚠ PER ADDRESS, THE MOST SPECIFIC RULE; ACROSS ADDRESSES, THE STRONGEST
 * MODE. Somebody with `a@pslhq.app` (suggest) and `a@dev.pslhq.app` (auto)
 * may auto-join - each address is proof in its own right. A workspace whose
 * most specific rule for every one of their addresses is `off` offers
 * nothing: `off` on `dev.pslhq.app` beats `auto` on `*.pslhq.app`.
 *
 * ⚠ ONLY UNDER THE DOMAIN THAT CARRIES THE RULE. A rule's pattern is checked
 * against its domain when saved; this checks it again, so a row written any
 * other way still cannot reach above what was proved.
 */
export function matchAccess(
  domains: readonly AccessDomain[],
  emails: string[],
): Match[] {
  const best = new Map<string, Match>()
  for (const raw of emails) {
    const email = raw.trim().toLowerCase()
    const at = email.lastIndexOf("@")
    if (at < 1) continue
    const host = email.slice(at + 1)
    if (isFreeMail(host)) continue
    // Per workspace, the most specific rule across its domains covering `host`.
    const perTenant = new Map<string, { rule: JoinRule; domain: AccessDomain }>()
    for (const domain of domains) {
      if (!within(host, domain.name)) continue
      const rule = ruleFor(
        domain.rules.filter((r) => patternProblem(r.pattern, domain.name) === null),
        host,
      )
      if (!rule) continue
      const held = perTenant.get(domain.tenantId)
      if (!held || specificity(rule.pattern) > specificity(held.rule.pattern))
        perTenant.set(domain.tenantId, { rule, domain })
    }
    for (const [tenantId, { rule, domain }] of perTenant) {
      if (rule.mode === "off") continue
      const held = best.get(tenantId)
      if (held && STRENGTH[held.mode] >= STRENGTH[rule.mode]) continue
      best.set(tenantId, {
        tenantId,
        clerkOrgId: domain.clerkOrgId,
        email,
        pattern: rule.pattern,
        mode: rule.mode,
        role: rule.role,
      })
    }
  }
  return [...best.values()]
}
