import type { Tone } from "@repo/ui/components/status"

/**
 * The one place state becomes colour.
 *
 * ⚠ EVERY STATE STRING IN THE PRODUCT MAPS THROUGH HERE, AND NOTHING ELSE
 * DECIDES WHAT A STATE LOOKS LIKE. Message statuses, delivery events, domain
 * verification, webhook health and Polar's subscription states are five
 * different vocabularies that a person reads in one session, and they have to
 * agree: if `bounced` is red in the email log and amber in the webhook log, the
 * colour has stopped being information. Adding a state means adding it to
 * `TONE` below, not styling it at a call site.
 *
 * ⚠ AND IT LIVES IN THE CONSOLE RATHER THAN IN `packages/ui`, WHICH IS THE
 * LAYER. Three of these keys are on the API's public contract and one set is
 * Polar's; a design-system package holding them would be a package every
 * product change has to be pushed through, and the console is the only thing
 * that reads them. What `packages/ui` owns is the DRAWING — five tones, a dot,
 * a pill, and the rule that the word is always in the DOM.
 */

/**
 * Every state string the product can show, mapped to a tone and a human label.
 *
 * ⚠ THE KEYS ARE THE WIRE VALUES, VERBATIM, INCLUDING RESEND'S. `not_started`,
 * `temporary_failure` and `delivery_delayed` are on the API's public contract —
 * see packages/contracts — so they arrive here exactly as a customer would see
 * them in their own code. Prettifying them at the boundary and mapping the
 * pretty version here would put a second vocabulary between the console and the
 * API, and the first bug it caused would be a state that renders as nothing.
 *
 * ⚠ `temporary_failure` IS AMBER, NOT RED, AND THIS IS THE WHOLE REASON THE
 * DISTINCTION EXISTS. SES uses it for a DNS lookup that failed in a way worth
 * retrying. Painting it as a failure tells a customer their correct records are
 * wrong, and they respond by changing records that were fine.
 */
const TONE: Record<string, { tone: Tone; label: string }> = {
  // core.messages.status
  queued: { tone: "neutral", label: "Queued" },
  sending: { tone: "info", label: "Sending" },
  sent: { tone: "info", label: "Sent" },
  failed: { tone: "danger", label: "Failed" },
  canceled: { tone: "neutral", label: "Canceled" },

  // The email event vocabulary — what SES and Stalwart report back.
  scheduled: { tone: "neutral", label: "Scheduled" },
  delivered: { tone: "success", label: "Delivered" },
  delivery_delayed: { tone: "warning", label: "Delayed" },
  bounced: { tone: "danger", label: "Bounced" },
  complained: { tone: "warning", label: "Complained" },
  rejected: { tone: "danger", label: "Rejected" },
  opened: { tone: "success", label: "Opened" },
  clicked: { tone: "success", label: "Clicked" },

  // core.domain_status
  not_started: { tone: "neutral", label: "Not started" },
  pending: { tone: "warning", label: "Pending" },
  verified: { tone: "success", label: "Verified" },
  temporary_failure: { tone: "warning", label: "Temporary failure" },

  // Webhook endpoints and deliveries.
  enabled: { tone: "success", label: "Enabled" },
  disabled: { tone: "neutral", label: "Disabled" },

  // Broadcasts.
  draft: { tone: "neutral", label: "Draft" },

  // Subscriptions, as Polar reports them.
  active: { tone: "success", label: "Active" },
  trialing: { tone: "info", label: "Trialing" },
  past_due: { tone: "danger", label: "Past due" },
  incomplete: { tone: "warning", label: "Incomplete" },
  unpaid: { tone: "danger", label: "Unpaid" },

  // Tenancy.
  suspended: { tone: "danger", label: "Suspended" },
  deleted: { tone: "neutral", label: "Deleted" },
}

/**
 * ⚠ AN UNKNOWN STATE RENDERS AS ITSELF, NEUTRAL, RATHER THAN THROWING OR
 * DISAPPEARING. The API is versioned separately from this app and can add an
 * event type tomorrow; a console that crashed on one would take a customer's
 * whole log down over a string it did not recognise, and one that rendered
 * nothing would quietly hide rows. Showing the raw value is honest and is also
 * the fastest possible bug report.
 */
export function describeStatus(status: string): { tone: Tone; label: string } {
  return TONE[status] ?? { tone: "neutral", label: status }
}
