/**
 * Which SES configuration set a message is sent through (#154).
 *
 * ⚠ FOUR SETS, BECAUSE TRACKING IS DECIDED BY THE SET, NOT BY THE MESSAGE. SES
 * inserts an open pixel into every message sent through a set whose event
 * destination publishes `OPEN`, and rewrites every link for `CLICK`. There is no
 * per-message switch, so "this domain tracks opens, that one does not" can only
 * be expressed by sending them through different sets:
 *
 *   <base>          SEND DELIVERY BOUNCE COMPLAINT REJECT DELIVERY_DELAY
 *                   RENDERING_FAILURE SUBSCRIPTION
 *   <base>-opens    the above + OPEN
 *   <base>-clicks   the above + CLICK
 *   <base>-tracked  the above + OPEN + CLICK
 *
 * All four publish to the same SNS topic, so ingestion cannot tell them apart
 * and does not need to. `<base>` is `SES_CONFIGURATION_SET`; the sets
 * themselves are created in SES, not by this code.
 *
 * ⚠ NONE OF THEM MAY CARRY `SuppressionOptions`. SES resolves suppression as
 * configuration set, then tenant, then account, so a set that names a scope or
 * reasons overrides every tenant's own list at once (#159) - and every message
 * goes through one of these four. See `TENANT_SUPPRESSION`.
 */

export interface Tracking {
  opens: boolean
  clicks: boolean
}

export const NO_TRACKING: Tracking = { opens: false, clicks: false }

export function configurationSetFor(base: string, tracking: Tracking): string {
  if (tracking.opens && tracking.clicks) return `${base}-tracked`
  if (tracking.opens) return `${base}-opens`
  if (tracking.clicks) return `${base}-clicks`
  return base
}

/**
 * Every set a send may name, which is every set an SES tenant must hold - SES
 * refuses a tenant send through a set that is not associated with the tenant.
 */
export const configurationSetsFor = (base: string): string[] => [
  base,
  `${base}-opens`,
  `${base}-clicks`,
  `${base}-tracked`,
]
