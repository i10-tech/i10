import { X509Certificate } from "node:crypto"
import { isIP } from "node:net"
import { z } from "zod"
import type { Connection } from "./model.js"
import type { IdentityStore } from "./ports.js"
import { oktaMailFor, type OktaMailSettings } from "./okta-mail.js"
import { isPermittedAddress } from "../webhooks/egress.js"

/**
 * LDAP pass-through for managed accounts (#344, sso.md 2.8, decision 6).
 *
 * A managed account's password belongs to its company's directory, so authd
 * never asks Clerk about it. Per connection, authd either passes the bind
 * through to the company's own LDAP server (these settings), or refuses it and
 * IMAP is off for that connection's accounts. There is no mailbox password.
 *
 * ⚠ WHERE THINGS LIVE. The settings are `config.ldap` (nothing secret - the
 * console shows it back). The service account's DN and secret are
 * `secrets.ldap`, sealed with the connection's other secrets and never read by
 * any route; only the setup test and authd's internal endpoint open them.
 *
 * ⚠ THE TRUST RULE (sso.md 2.14) APPLIES: these decide whom the connection's
 * accounts' passwords are asked of. On an active or disabled connection,
 * changing or enabling them needs `owners:manage` and step-up
 * (routes/console/identity-ldap.ts).
 */

export const LDAP_PORTS = [389, 636] as const
export const TLS_MODES = ["ldaps", "starttls"] as const
export type TlsMode = (typeof TLS_MODES)[number]

/** A passing setup test is good for this long, and for the settings it tested. */
export const TEST_VALID_MS = 24 * 60 * 60 * 1000

/** Where the user's address goes in the filter template. */
export const FILTER_PLACEHOLDER = "{email}"

/**
 * An attribute value in a filter, escaped as RFC 4515 section 3 says.
 *
 * ⚠ EVERY ADDRESS THAT REACHES A FILTER GOES THROUGH THIS. A filter is built
 * from text and an address is not trusted text: `*` makes a wildcard, `)`
 * ends the term and starts one of the attacker's.
 */
export function escapeFilterValue(value: string): string {
  let out = ""
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\5c"
        break
      case "*":
        out += "\\2a"
        break
      case "(":
        out += "\\28"
        break
      case ")":
        out += "\\29"
        break
      case "\0":
        out += "\\00"
        break
      default:
        out += ch
    }
  }
  return out
}

/** The template with the address substituted, escaped. `split`, not `replace`: no `$&` surprises. */
export function renderFilter(template: string, address: string): string {
  return template.split(FILTER_PLACEHOLDER).join(escapeFilterValue(address))
}

/** A control character of any kind, or a Unicode line separator. */
function hasControl(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0)!
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029)
      return true
  }
  return false
}

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A host an LDAP server may live at: a dotted name, or a public IP literal.
 *
 * ⚠ THE STRING CHECK IS NOT THE GUARD, as for an OIDC issuer: it refuses what
 * is obviously wrong so the admin hears it at once. The real check is the
 * egress guard, which resolves the name and vets every address at every use.
 */
const host = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine(
    (v) => {
      const bare = v.replace(/^\[(.*)\]$/, "$1")
      return isIP(bare) ? isPermittedAddress(bare) : HOSTNAME.test(v)
    },
    { message: "host must be a public host name or address." },
  )
  .transform((v) => v.replace(/^\[(.*)\]$/, "$1"))

/** One to four certificates, PEM, and nothing else in the text. */
function pinnedCa(value: string): boolean {
  if (value.length > 20_000) return false
  const blocks = value.match(
    /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g,
  )
  if (!blocks || blocks.length > 4) return false
  // ⚠ NOTHING BUT CERTIFICATES: a private key pasted by mistake must not be stored.
  const rest = blocks.reduce((text, b) => text.replace(b, ""), value)
  if (rest.trim() !== "") return false
  try {
    for (const b of blocks) new X509Certificate(b)
    return true
  } catch {
    return false
  }
}

/** Balanced, and an `(...)` all the way round: the template is one filter. */
function wellFormedFilter(template: string): boolean {
  if (!template.startsWith("(") || !template.endsWith(")")) return false
  let depth = 0
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "(") depth++
    if (ch === ")") {
      depth--
      if (depth < 0) return false
      if (depth === 0 && i !== template.length - 1) return false
    }
  }
  return depth === 0
}

const dn = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(512)
    .refine((v) => !hasControl(v), {
      message: `${label} has a character that is not allowed.`,
    })

/** The PUT body: only what is present changes. */
export const ldapSettingsInput = z
  .object({
    host: host.optional(),
    port: z
      .number()
      .refine((p): p is 389 | 636 => (LDAP_PORTS as readonly number[]).includes(p), {
        message: "port must be 389 or 636.",
      })
      .optional(),
    tlsMode: z.enum(TLS_MODES).optional(),
    caPem: z
      .string()
      .trim()
      .refine(pinnedCa, {
        message: "caPem must be one to four PEM certificates, and nothing else.",
      })
      .nullable()
      .optional(),
    searchBase: dn("searchBase").optional(),
    userFilter: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((v) => !hasControl(v), {
        message: "userFilter has a character that is not allowed.",
      })
      .refine((v) => v.includes(FILTER_PLACEHOLDER), {
        message: `userFilter must contain ${FILTER_PLACEHOLDER}, where the address goes.`,
      })
      .refine(wellFormedFilter, {
        message: "userFilter must be one filter in parentheses, like (mail={email}).",
      })
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export type LdapSettingsInput = z.infer<typeof ldapSettingsInput>

/** The service account, write-only. */
export const ldapServiceInput = z
  .object({
    bindDn: dn("bindDn"),
    bindSecret: z
      .string()
      .min(1)
      .max(1024)
      .refine((v) => !hasControl(v), {
        message: "bindSecret has a character that is not allowed.",
      }),
  })
  .strict()

/** The setup test's body. The password is used for this request and kept nowhere. */
export const ldapTestInput = z
  .object({
    address: z.string().trim().toLowerCase().email().max(320),
    password: z.string().min(1).max(1024).optional(),
  })
  .strict()

/** `config.ldap`: everything but the service account, which is sealed. */
export interface StoredLdap {
  host?: string
  port?: number
  tlsMode?: TlsMode
  caPem?: string | null
  searchBase?: string
  userFilter?: string
  enabled?: boolean
  /** The service account is stored (sealed). */
  serviceSet?: boolean
  /**
   * Bumped by every change to what a test would exercise. A pass is recorded
   * against the revision it ran on, so a pass for old settings cannot enable
   * new ones.
   */
  revision?: number
  /** When a test last passed on `revision`; cleared by any change. */
  testedAt?: string | null
}

/** `secrets.ldap`: the service account. */
export interface SealedLdap {
  bindDn?: string
  bindSecret?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export function storedLdap(connection: Pick<Connection, "config">): StoredLdap {
  const raw = connection.config.ldap
  return isRecord(raw) ? (raw as StoredLdap) : {}
}

export function sealedLdap(secrets: Record<string, unknown>): SealedLdap {
  const raw = secrets.ldap
  return isRecord(raw) ? (raw as SealedLdap) : {}
}

/** Everything a bind through the directory needs, or null while something is missing. */
export interface PassthroughSettings {
  host: string
  port: 389 | 636
  tlsMode: TlsMode
  caPem: string | null
  searchBase: string
  userFilter: string
  bindDn: string
  bindSecret: string
}

export function completeSettings(
  stored: StoredLdap,
  sealed: SealedLdap,
): PassthroughSettings | null {
  if (
    !stored.host ||
    (stored.port !== 389 && stored.port !== 636) ||
    (stored.tlsMode !== "ldaps" && stored.tlsMode !== "starttls") ||
    !stored.searchBase ||
    !stored.userFilter ||
    !stored.userFilter.includes(FILTER_PLACEHOLDER) ||
    !sealed.bindDn ||
    !sealed.bindSecret
  )
    return null
  return {
    host: stored.host,
    port: stored.port,
    tlsMode: stored.tlsMode,
    caPem: stored.caPem ?? null,
    searchBase: stored.searchBase,
    userFilter: stored.userFilter,
    bindDn: sealed.bindDn,
    bindSecret: sealed.bindSecret,
  }
}

/** A test passed on these settings, and recently enough. */
export function testIsFresh(stored: StoredLdap, now: Date): boolean {
  if (!stored.testedAt) return false
  const at = Date.parse(stored.testedAt)
  return (
    Number.isFinite(at) && at <= now.getTime() && now.getTime() - at < TEST_VALID_MS
  )
}

/** The fields whose change is a change of who is trusted (the whole set, bar `enabled`). */
export const LDAP_SETTING_FIELDS = [
  "host",
  "port",
  "tlsMode",
  "caPem",
  "searchBase",
  "userFilter",
] as const

/**
 * What authd is told about a connection: nothing, or the lane its managed
 * accounts' passwords are asked of and everything that lane needs.
 *
 * ⚠ `enabled` STAYS ON EVERY ANSWER, beside `lane`. An authd from before the
 * lane existed reads an Okta answer as an LDAP one with no host (unavailable),
 * not as "off" (a refusal that tells mail clients the password is wrong), so the
 * two can roll out in either order. A missing `lane` is LDAP to a new authd.
 */
export type PassthroughAnswer =
  | { enabled: false }
  | ({ enabled: true; lane: "ldap" } & PassthroughSettings)
  | ({ enabled: true; lane: "okta" } & OktaMailSettings)

/**
 * The answer to authd's question (routes/authd.ts), from the stored rows.
 *
 * ⚠ ONE LANE, THE LDAP ONE IF BOTH ARE ON. The console refuses to turn either on
 * while the other is (routes/console/identity-okta-mail.ts, identity-ldap.ts),
 * so a connection with both enabled is something a route did not do: a row
 * edited by hand, or two writes that raced. LDAP wins, and the reason is what it
 * protects: it was here first, so adding Okta can never change whose directory
 * an existing LDAP connection's members' passwords go to. The `enabled` flag
 * picks the lane, not completeness: an LDAP lane that is on but half set answers
 * "off" and does not fall through to Okta.
 *
 * ⚠ ENABLED ONLY IF THE SETTINGS ARE WHOLE. A half-set connection answers
 * "off", which authd turns into a refusal - never into a bind against a host
 * or filter that was only partly chosen. A database or unsealing failure is
 * NOT an answer: it throws, and the route says 503.
 */
export async function passthroughFor(
  store: Pick<
    IdentityStore,
    "connectionForStart" | "connectionSecrets" | "liveDomains"
  >,
  connectionId: string,
): Promise<PassthroughAnswer> {
  const connection = await store.connectionForStart(connectionId)
  if (!connection) return { enabled: false }
  // ⚠ A CONNECTION THAT IS NOT LIVE ANSWERS "OFF". `status` is `active` only while an owner has it on; a draft, a
  // test run or a disabled connection (an owner's off switch) must stop asking its
  // company's directory for passwords, and `enabled` in the settings is a
  // different thing (the pass-through switch), left on when a connection is
  // disabled. And a live proof of at least one domain must still back it: when the
  // proof lapses or another workspace takes the name, nobody at that name is
  // signed in through this connection either (the bridge reads the same columns),
  // so its people's mail passwords stop going to a directory nothing vouches for.
  if (connection.status !== "active") return { enabled: false }
  if ((await store.liveDomains(connection.tenantId, connection.id)).length === 0)
    return { enabled: false }
  const stored = storedLdap(connection)
  if (stored.enabled === true) {
    const secrets = await store.connectionSecrets(connection.tenantId, connection.id)
    const settings = completeSettings(stored, secrets ? sealedLdap(secrets) : {})
    return settings ? { enabled: true, lane: "ldap", ...settings } : { enabled: false }
  }
  const okta = oktaMailFor(connection)
  return okta ? { enabled: true, lane: "okta", ...okta } : { enabled: false }
}
