import { eq } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { domains } from "../db/core.js"
import type { SecretBox } from "../webhooks/signing.js"
import type { DkimKey } from "./dkim.js"

/**
 * The domain's DKIM key, unsealed, for the direct transport to sign with.
 *
 * ⚠ READ WITHOUT A TENANT CONTEXT, DELIBERATELY, AND THIS IS THE ONE PLACE THAT
 * IS DEFENSIBLE. Every other reader of `core.domains` goes through
 * `withTenant()` so RLS scopes it. Here the caller is the send worker holding a
 * message it has already claimed — it knows the sending domain and needs the
 * key for exactly that domain — and the tenant id it would set is the one it
 * would then be trusting itself to have derived correctly. Looking the key up
 * by DOMAIN NAME, which is globally unique, removes that step: there is no
 * tenant parameter to get wrong.
 *
 * ⚠ AND IT IS SCOPED TO ONE COLUMN PAIR ON ONE ROW. Nothing else about the
 * domain is selected, so a bug here cannot widen into reading another tenant's
 * anything.
 */

export interface SigningKeyOptions {
  db: Database
  secrets: SecretBox
  /**
   * How long an unsealed key may be reused.
   *
   * ⚠ A CACHE BECAUSE THIS IS ON THE HOT PATH OF EVERY DIRECT SEND, and a TTL
   * rather than forever because DKIM rotation is a thing we intend to do. A
   * process holding a retired key indefinitely would keep signing with it until
   * somebody restarted the worker, and the symptom — mail failing DKIM for one
   * replica only — is close to undiagnosable from the outside.
   */
  ttlMs?: number
}

/** Everything the direct transport needs about one sending domain. */
export interface DomainSending {
  dkim: DkimKey
  /**
   * The label the return path sits under, e.g. `bounce`.
   *
   * ⚠ IT COMES FROM THE ROW RATHER THAN FROM CONFIGURATION, because it is what
   * the CUSTOMER published. `dnsRecordsFor` emitted the MX and TXT for this
   * exact name; an envelope sender under any other label has no SPF record
   * behind it and no MX to bounce to.
   */
  bounceSubdomain: string
}

export function domainSendingLookup(
  opts: SigningKeyOptions,
): (domain: string) => Promise<DomainSending | null> {
  const ttl = opts.ttlMs ?? 5 * 60_000
  const cache = new Map<string, { at: number; value: DomainSending | null }>()

  return async (domain: string) => {
    const hit = cache.get(domain)
    if (hit && Date.now() - hit.at < ttl) return hit.value

    const [row] = await opts.db
      .select({
        selector: domains.dkimSelector,
        sealed: domains.dkimPrivateKeySealed,
        bounceSubdomain: domains.bounceSubdomain,
      })
      .from(domains)
      .where(eq(domains.name, domain))
      .limit(1)

    // ⚠ A MISS IS CACHED TOO, AND ON PURPOSE. Without it, a domain that has no
    // key — a provisioning bug, or mail from a domain we do not host — would
    // hit the database once per message forever while every one of those sends
    // is rejected anyway.
    const value: DomainSending | null =
      row?.selector && row.sealed
        ? {
            dkim: { selector: row.selector, privateKey: opts.secrets.open(row.sealed) },
            bounceSubdomain: row.bounceSubdomain,
          }
        : null

    cache.set(domain, { at: Date.now(), value })
    return value
  }
}
