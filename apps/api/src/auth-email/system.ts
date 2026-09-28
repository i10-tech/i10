import type { Sql } from "postgres"
import type { Database } from "../db/client.js"
import { acceptDatabaseOps, type SendPathOptions } from "../send/accept-db.js"
import { domainOf } from "../send/address.js"
import type { Metering } from "../send/metering.js"
import type { Logger } from "../send/accept.js"
import { authEmailSender } from "./sender.js"
import type { AuthEmailSender } from "./deliver.js"

/**
 * The sender for mail i10 sends as itself, or null when it cannot be built.
 *
 * ⚠ ONE BUILDER FOR EVERY PROCESS THAT SENDS OUR MAIL. The API sends auth codes
 * and transfer offers; the daily re-check sends the "sending paused" notice a
 * poll found (#157). Two hand-built copies would drift on exactly the details
 * that matter - the exemption, the pause bypass, which tenant it sends as.
 *
 * ⚠ NULL IS A SAFE ANSWER, NOT AN ERROR. Without it Clerk keeps delivering its
 * own auth mail and the notices are skipped; the reasons are logged loudly.
 */
export async function systemSenderFor({
  sql,
  db,
  queues,
  metering,
  from,
  tenantSlug,
  log,
}: {
  sql: Sql
  db: Database
  queues: SendPathOptions["queues"]
  metering: Metering
  /** `AUTH_EMAIL_FROM`, defaulting to `SYSTEM_FROM`. */
  from: string
  tenantSlug: string
  log: Logger & {
    warn: (o: object, m: string) => void
    info?: (o: object, m: string) => void
  }
}): Promise<AuthEmailSender | null> {
  /*
   * The domain our mail leaves from.
   *
   * ⚠ IT IS THE ONE DOMAIN THE SEND GATE EXEMPTS, and it has to be derived here
   * rather than assumed, because `AUTH_EMAIL_FROM` is configuration and may be a
   * subdomain. See `SendPathOptions.alwaysSendable` for why the exemption exists
   * at all and why it is attached to an ops object rather than to a request.
   *
   * ⚠ AN UNPARSEABLE OVERRIDE IS A MISCONFIGURATION THAT MUST NOT PASS QUIETLY.
   * `AUTH_EMAIL_FROM` defaults to a good address (`SYSTEM_FROM`), but Doppler
   * can override it with a value that has no address in it at all - and without
   * a domain there is no exemption and the send gate refuses our own mail,
   * which is a sign-up nobody can complete. So this says so loudly and declines
   * to take over, which leaves Clerk delivering.
   */
  const domain = domainOf(from)
  if (!domain) {
    log.error(
      { from },
      "AUTH_EMAIL_FROM has no parseable domain - clerk keeps delivering its own",
    )
    return null
  }

  /*
   * i10's own tenant, for the mail i10 sends about itself.
   *
   * ⚠ RESOLVED ONCE AT BOOT AND ALLOWED TO BE ABSENT. A fresh database has no
   * `i10` tenant - migration 0029 inserts one only where it already exists - so
   * this is null on a new deployment and authentication mail simply stays with
   * Clerk. Failing to boot over it would make the process refuse to start on
   * exactly the deployments that have no customers to email.
   */
  let tenantId: string | null
  try {
    // ⚠ THROUGH THE DEFINER, NOT `select … from core.tenants`. That table is
    // under RLS and its policy reads `current_setting('app.tenant_id')`
    // strictly, which nothing has set this early - so the direct read did not
    // return zero rows, it RAISED. It cannot be repaired with `withTenant()`
    // either: that needs the tenant id, and the id is what this is looking
    // for. See migration 0032.
    const rows = await sql<{ id: string | null }[]>`
      select core.tenant_id_by_slug(${tenantSlug})::text as id`
    tenantId = rows[0]?.id ?? null
    if (!tenantId) {
      log.warn(
        { slug: tenantSlug },
        "no tenant for auth email - clerk keeps delivering its own",
      )
      return null
    }
  } catch (err) {
    // ⚠ CAUGHT, BECAUSE THE RLS FAULT ABOVE ONCE TOOK THE WHOLE API DOWN WITH IT.
    // However this fails, the right outcome is the one this value already has a
    // name for - no sender, and Clerk keeps delivering. Loud in the log, not in
    // the exit code.
    log.error(
      { slug: tenantSlug, err: String(err) },
      "could not resolve the auth email tenant - clerk keeps delivering its own",
    )
    return null
  }

  return authEmailSender({
    tenantId,
    from,
    /*
     * ⚠ ITS OWN OPS OBJECT, CARRYING THE ONE EXEMPTION THE SEND GATE ALLOWS.
     * `DomainStore.create` refuses to create a row for our own sending domains,
     * so `AUTH_EMAIL_FROM` can never be a verified domain and the gate would
     * refuse every password reset in the product. Scoping the exemption to the
     * object this path builds - rather than to a flag on a request - is what
     * keeps it unreachable from a customer's send.
     */
    ops: acceptDatabaseOps({
      db,
      queues,
      alwaysSendable: [domain],
      // ⚠ OUR MAIL SENDS THROUGH ITS OWN SES TENANT (#206), so a pause on our
      // workspace's tenant must not refuse a sign-in code (#157).
      honourSesPause: false,
    }),
    metering,
    log,
  })
}
