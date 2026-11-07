import { isIP } from "node:net"
import { z } from "zod"
import type { Connection } from "./model.js"

/**
 * Okta as the place a managed account's MAIL password is asked (#383, B9).
 *
 * A managed account's password belongs to its company, so authd never asks Clerk
 * about it (ldap.ts). For an Okta connection the company's directory is Okta
 * itself: authd sends the password to the org's authorization server as an OAuth
 * password grant, and Okta's yes or no is the answer.
 *
 * ⚠ NOTHING HERE IS A SECRET. The settings are the authorization server's URL and
 * a PUBLIC client id (an Okta native app with `token_endpoint_auth_method: none`).
 * They live in `config.oktaMail` and are shown back as they are; nothing is
 * sealed, and i10 stores no mail password, hash, app password or per-device
 * secret for this.
 *
 * ⚠ WHERE THINGS LIVE: `config.oktaMail` = `{ issuer, clientId, enabled }`, and
 * only that. Event-hook state (step 2b) is kept elsewhere on the connection, so
 * a write here never has to know about it; the routes spread what they find.
 *
 * ⚠ THE TRUST RULE (sso.md 2.14) APPLIES, HARDER THAN FOR AN ISSUER OF SIGN-IN:
 * the issuer decides which server every member's mail password is POSTed to. An
 * attacker-chosen issuer is a password harvester, so changing or enabling these
 * is an owner's move, with step-up (routes/console/identity-okta-mail.ts).
 */

/** The key in the connection's `config`. */
export const OKTA_MAIL_KEY = "oktaMail"

/** The fields whose change is a change of who is trusted. */
export const OKTA_MAIL_FIELDS = ["issuer", "clientId"] as const

// Mirrors services/authd/internal/okta (Settings.Validate): the API and authd
// must agree, or a value saved here is refused at the first bind.
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SERVER_PATH = /^\/oauth2\/[0-9A-Za-z]{1,64}$/
const CLIENT_ID = /^0oa[0-9A-Za-z]{17}$/

/** A space or a control character of any kind. (ldap.ts has the same loop, without the space; it imports this file.) */
function hasControlOrSpace(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0)!
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/**
 * The issuer in the one form authd accepts, or null.
 *
 * `https://<dns name>/oauth2/default` or `/oauth2/<server id>`: no port, no
 * credentials, no query, no fragment, no IP literal. A trailing slash is
 * dropped and the host lower-cased, so what is stored is what authd compares.
 *
 * ⚠ THE STRING CHECK IS NOT THE EGRESS GUARD, as for an OIDC issuer or an LDAP
 * host. It refuses what is obviously wrong so the admin hears it at once; the
 * real check resolves the name and vets every address at every connection
 * (services/authd/internal/egress).
 */
export function canonicalIssuer(raw: string): string | null {
  // ⚠ The URL parser DROPS tabs and newlines, where authd's refuses them. A value
  // the two read differently is one they disagree about.
  if (hasControlOrSpace(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password) return null
  if (url.port || url.search || url.hash) return null
  const host = url.hostname
  const bare = host.replace(/^\[(.*)\]$/, "$1")
  if (isIP(bare) !== 0 || !HOSTNAME.test(host)) return null
  // `127.1.2.3`-shaped names that are not an address in the strict sense.
  if (/^[0-9]+$/.test(host.slice(host.lastIndexOf(".") + 1))) return null
  const path = url.pathname.replace(/\/$/, "")
  if (!SERVER_PATH.test(path)) return null
  return `https://${host}${path}`
}

export const isClientId = (value: string): boolean => CLIENT_ID.test(value)

/** The PUT body: only what is present changes. */
export const oktaMailInput = z
  .object({
    issuer: z
      .string()
      .trim()
      .max(512)
      .refine((v) => canonicalIssuer(v) !== null, {
        message:
          "issuer must be an https URL like https://your-org.okta.com/oauth2/default (a custom authorization server, no port).",
      })
      .transform((v) => canonicalIssuer(v) as string)
      .optional(),
    clientId: z
      .string()
      .trim()
      .refine(isClientId, {
        message: "clientId must be an Okta client id, like 0oa1b2c3d4e5f6g7h8i9.",
      })
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export type OktaMailInput = z.infer<typeof oktaMailInput>

/** `config.oktaMail`. */
export interface StoredOktaMail {
  issuer?: string
  clientId?: string
  enabled?: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export function storedOktaMail(connection: Pick<Connection, "config">): StoredOktaMail {
  const raw = connection.config[OKTA_MAIL_KEY]
  return isRecord(raw) ? (raw as StoredOktaMail) : {}
}

/** What authd needs to ask Okta about a password. */
export interface OktaMailSettings {
  issuer: string
  clientId: string
}

/**
 * The settings, or null while something is missing or no longer valid.
 *
 * ⚠ RE-CHECKED ON READ. The column is JSON that anything with write access can
 * change; a value that would not pass the PUT is not handed to authd.
 */
export function completeOktaMail(stored: StoredOktaMail): OktaMailSettings | null {
  if (typeof stored.issuer !== "string" || typeof stored.clientId !== "string")
    return null
  const issuer = canonicalIssuer(stored.issuer)
  if (issuer === null || issuer !== stored.issuer || !isClientId(stored.clientId))
    return null
  return { issuer, clientId: stored.clientId }
}

/**
 * The Okta lane for a connection, or null if it does not run one.
 *
 * ⚠ ONLY AN OKTA CONNECTION, enabled, whole. A connection's `provider` is what
 * says its people are Okta's, so `config.oktaMail` on any other is ignored even
 * if something put it there.
 */
export function oktaMailFor(
  connection: Pick<Connection, "provider" | "config">,
): OktaMailSettings | null {
  if (connection.provider !== "okta") return null
  const stored = storedOktaMail(connection)
  return stored.enabled === true ? completeOktaMail(stored) : null
}
