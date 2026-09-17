/**
 * What an endpoint can subscribe to.
 *
 * ⚠ THESE STRINGS ARE THE API'S PUBLIC CONTRACT AND ARRIVE IN CUSTOMER CODE AS
 * LITERALS — see `webhookEventType` in apps/api/src/db/core.ts. A rename is a
 * breaking change to every `if (event.type === …)` anybody has written, and it
 * breaks SILENTLY: their handler stops matching and does nothing. Add, never
 * rename.
 *
 * ⚠ AND THE LIST HERE MUST STAY A SUBSET OF THE ENUM. A checkbox for an event
 * the API does not accept produces a 422 at the end of a form somebody has just
 * filled in, which reads as our bug rather than as an unsupported option.
 */
export const WEBHOOK_EVENTS = [
  {
    value: "email.sent",
    label: "Sent",
    description: "We accepted the message and handed it to the MTA.",
  },
  {
    value: "email.delivered",
    label: "Delivered",
    description: "The receiving server accepted it. The best signal you get.",
  },
  {
    value: "email.delivery_delayed",
    label: "Delayed",
    description: "A temporary failure — a full mailbox, a greylist. Still trying.",
  },
  {
    value: "email.bounced",
    label: "Bounced",
    description: "Permanently rejected. The address is suppressed automatically.",
  },
  {
    value: "email.complained",
    label: "Complained",
    description: "Delivered, then marked as spam. Watch this one closely.",
  },
  {
    value: "email.failed",
    label: "Failed",
    description: "We could not send it at all.",
  },
] as const

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number]["value"]
