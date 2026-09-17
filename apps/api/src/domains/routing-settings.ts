import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"

/**
 * Publishing the two environment-held routing inputs where Stalwart can read
 * them.
 *
 * ⚠ THE MAILBOX LEVER RUNS INSIDE POSTGRES AND CANNOT SEE OUR PODS' ENVIRONMENT.
 * `core.mailbox_route` is called by Stalwart's `MtaOutboundStrategy` expression
 * to decide where a domain's human mail goes, and the rule needs four inputs:
 * the domain's override and the tenant's plan, which are rows, and `SES_ENABLED`
 * and `METERING_FREE_PLAN_ID`, which are not. This copies the second pair into
 * `core.routing_settings` so one rule has one answer.
 *
 * ⚠ THE ENVIRONMENT STAYS THE AUTHORED SOURCE. Nobody edits that row by hand;
 * it is overwritten on every boot from `env`. Editing it directly works until
 * the next deploy and then silently reverts, which is worse than not being able
 * to edit it at all — so the column comments say so and this is the only writer.
 *
 * ⚠ WITHOUT IT THE KILL SWITCH ONLY MOVES HALF THE MAIL. `SES_ENABLED` thrown
 * during an incident redirects transactional sends immediately, because the
 * worker reads it directly. Mailbox mail is routed inside Stalwart, which would
 * carry on relaying to the thing that is down.
 */

export interface RoutingSettings {
  sesEnabled: boolean
  /**
   * Whether SES's SMTP endpoint is configured as a relay for mailbox mail.
   *
   * ⚠ NOT THE SAME SWITCH AS `sesEnabled`, AND NOT DERIVABLE FROM IT. The
   * transactional route uses the SES API; mailbox mail can only use SES SMTP,
   * because Stalwart's outbound has no HTTP hook. Those are separate credentials
   * that can exist independently, and until the SMTP ones do, every mailbox
   * domain must keep leaving by our own MTA.
   */
  sesRelayEnabled: boolean
  freePlanId: string
}

/**
 * ⚠ AN UPSERT ONTO ONE FIXED KEY, NOT AN INSERT. The row is created by 0036, so
 * this only ever updates — but writing it as an upsert means a database restored
 * from a backup taken before that migration still converges instead of leaving
 * the mail server with no settings to read.
 *
 * ⚠ AND IT IS NOT FATAL IF IT FAILS. The API's job is to serve the API; a
 * failure here leaves Stalwart reading the previous values, which are the
 * previous deploy's and therefore not nonsense. Refusing to boot over it would
 * turn a stale routing flag into an outage.
 */
export async function publishRoutingSettings(
  db: Database,
  settings: RoutingSettings,
): Promise<void> {
  await db.execute(sql`
    insert into core.routing_settings
      (id, ses_enabled, ses_relay_enabled, free_plan_id, updated_at)
    values
      (true, ${settings.sesEnabled}, ${settings.sesRelayEnabled}, ${settings.freePlanId}, now())
    on conflict (id) do update
      set ses_enabled       = excluded.ses_enabled,
          ses_relay_enabled = excluded.ses_relay_enabled,
          free_plan_id      = excluded.free_plan_id,
          updated_at        = now()
  `)
}
