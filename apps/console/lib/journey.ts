/**
 * The steps of a resource's trip - an email from accepted to clicked, a domain
 * from added to verified, a broadcast from draft to sent - as the horizontal
 * "events" strip under a detail page's header draws them (Resend's "Email
 * events" and "Domain events").
 *
 * ⚠ PURE, SO IT IS TESTED WITHOUT A BROWSER. The component only draws.
 *
 * ⚠ A STEP THAT HAS NOT HAPPENED IS SHOWN, DIMMED, ONLY WHERE IT IS STILL
 * EXPECTED. A bounced email is not "waiting to be delivered", and drawing a
 * grey Delivered after a red Bounced would say it might still be.
 */

export type JourneyTone =
  "neutral" | "info" | "success" | "warning" | "danger" | "violet"

export type JourneyIcon =
  | "queued"
  | "scheduled"
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "rejected"
  | "failed"
  | "complained"
  | "opened"
  | "clicked"
  | "unsubscribed"
  | "canceled"
  | "created"
  | "records"
  | "verified"
  | "draft"

export interface JourneyStep {
  key: string
  label: string
  icon: JourneyIcon
  tone: JourneyTone
  /** `done`: happened. `current`: in progress. `pending`: still expected. */
  state: "done" | "current" | "pending"
  /** When it happened; absent for a step that has not. */
  at?: string
  /** A line under the label when there is no time to show, or beside it. */
  note?: string
  /** How many times it happened, when more than once (several recipients). */
  count?: number
}

// ── Email ─────────────────────────────────────────────────────────────────

const EMAIL_STEP: Record<
  string,
  { label: string; icon: JourneyIcon; tone: JourneyTone }
> = {
  sent: { label: "Sent", icon: "sent", tone: "neutral" },
  delivery_delayed: { label: "Delayed", icon: "delayed", tone: "warning" },
  delivered: { label: "Delivered", icon: "delivered", tone: "success" },
  bounced: { label: "Bounced", icon: "bounced", tone: "danger" },
  rejected: { label: "Rejected", icon: "rejected", tone: "danger" },
  failed: { label: "Failed", icon: "failed", tone: "danger" },
  complained: { label: "Complained", icon: "complained", tone: "warning" },
  opened: { label: "Opened", icon: "opened", tone: "info" },
  clicked: { label: "Clicked", icon: "clicked", tone: "violet" },
  unsubscribed: { label: "Unsubscribed", icon: "unsubscribed", tone: "warning" },
}

/** Where each event sits on the trip. */
const RANK: Record<string, number> = {
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  bounced: 3,
  rejected: 3,
  failed: 3,
  complained: 4,
  opened: 5,
  clicked: 6,
  unsubscribed: 7,
}

/** Events that end the trip: nothing after them is still expected. */
const DEAD_END = new Set(["bounced", "rejected", "failed"])

export function emailJourney(email: {
  created_at: string
  scheduled_at: string | null
  status: string
  events: { type: string; occurred_at: string }[]
}): JourneyStep[] {
  const steps: JourneyStep[] = [
    // ⚠ SYNTHESISED FROM `created_at`: nothing emits the moment WE accepted it.
    {
      key: "queued",
      label: "Queued",
      icon: "queued",
      tone: "neutral",
      state: "done",
      at: email.created_at,
    },
  ]
  if (email.scheduled_at) {
    steps.push({
      key: "scheduled",
      label: "Scheduled",
      icon: "scheduled",
      tone: "neutral",
      state: new Date(email.scheduled_at).getTime() <= Date.now() ? "done" : "current",
      at: email.scheduled_at,
    })
  }

  // The first time each kind of event happened, in the order they happened.
  // ⚠ SEVERAL RECIPIENTS GIVE SEVERAL EVENTS OF ONE KIND; the step says how
  // many rather than drawing the same step twice.
  // ⚠ ORDERED BY THE TRIP, THEN BY TIME. Providers' clocks disagree - a
  // delivery report can carry a timestamp a second before our own "sent" -
  // and a strip reading Delivered then Sent is a story that cannot happen.
  const sorted = [...email.events].sort(
    (a, b) =>
      (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9) ||
      a.occurred_at.localeCompare(b.occurred_at),
  )
  const seen = new Map<string, JourneyStep>()
  for (const event of sorted) {
    const shape = EMAIL_STEP[event.type]
    if (!shape) continue
    const existing = seen.get(event.type)
    if (existing) {
      existing.count = (existing.count ?? 1) + 1
      continue
    }
    const step: JourneyStep = {
      key: event.type,
      ...shape,
      state: "done",
      at: event.occurred_at,
    }
    seen.set(event.type, step)
    steps.push(step)
  }

  if (email.status === "canceled") {
    steps.push({
      key: "canceled",
      label: "Canceled",
      icon: "canceled",
      tone: "neutral",
      state: "done",
      note: "Never sent",
    })
    return steps
  }

  const ended = [...seen.keys()].some((type) => DEAD_END.has(type))
  if (!ended) {
    if (!seen.has("sent") && !seen.has("delivered")) {
      steps.push({
        key: "sent",
        label: "Sent",
        icon: "sent",
        tone: "neutral",
        state: email.status === "sending" ? "current" : "pending",
      })
    }
    if (!seen.has("delivered")) {
      steps.push({
        key: "delivered",
        label: "Delivered",
        icon: "delivered",
        tone: "success",
        state: seen.has("sent") || seen.has("delivery_delayed") ? "current" : "pending",
      })
    }
  }
  return steps
}

// ── Domain ────────────────────────────────────────────────────────────────

export function domainJourney(domain: {
  status: string
  created_at: string
  verified_at?: string | null
  dns_checked_at?: string | null
  displaced_at?: string | null
  records: { status: string }[]
}): JourneyStep[] {
  const created: JourneyStep = {
    key: "created",
    label: "Created",
    icon: "created",
    tone: "neutral",
    state: "done",
    at: domain.created_at,
  }
  const found = domain.records.filter((r) => r.status === "verified").length
  const all = domain.records.length > 0 && found === domain.records.length
  const checked = domain.dns_checked_at ?? undefined

  if (domain.displaced_at) {
    return [
      created,
      {
        key: "records",
        label: "Records validated",
        icon: "records",
        tone: "neutral",
        state: "done",
      },
      {
        key: "verified",
        label: "Verified elsewhere",
        icon: "failed",
        tone: "danger",
        state: "done",
        at: domain.displaced_at,
        note: "Another workspace proved this domain",
      },
    ]
  }

  const verified = domain.status === "verified"
  const records: JourneyStep =
    verified || all
      ? {
          key: "records",
          label: "Records validated",
          icon: "records",
          tone: "neutral",
          state: "done",
          ...(verified ? {} : checked ? { at: checked } : {}),
          ...(verified ? { note: "Found in DNS" } : {}),
        }
      : {
          key: "records",
          label:
            found > 0
              ? `${found} of ${domain.records.length} records found`
              : "Records validated",
          icon: "records",
          tone: found > 0 ? "warning" : "neutral",
          state: domain.status === "not_started" ? "pending" : "current",
          ...(checked
            ? { at: checked, note: "Last checked" }
            : { note: "Waiting for DNS" }),
        }

  const final: JourneyStep = verified
    ? {
        key: "verified",
        label: all ? "Verified" : "Partially verified",
        icon: "verified",
        tone: "success",
        state: "done",
        ...(domain.verified_at ? { at: domain.verified_at } : {}),
      }
    : domain.status === "failed"
      ? {
          key: "verified",
          label: "Failed",
          icon: "failed",
          tone: "danger",
          state: "done",
          note: "Records missing or wrong",
        }
      : domain.status === "temporary_failure"
        ? {
            key: "verified",
            label: "Temporary failure",
            icon: "delayed",
            tone: "warning",
            state: "current",
            note: "Retrying",
          }
        : {
            key: "verified",
            label: "Verified",
            icon: "verified",
            tone: "success",
            state: "pending",
          }

  return [created, records, final]
}

// ── Broadcast ─────────────────────────────────────────────────────────────

export function broadcastJourney(broadcast: {
  status: string
  created_at: string
  scheduled_at: string | null
  sent_at: string | null
  recipient_count: number | null
}): JourneyStep[] {
  const steps: JourneyStep[] = [
    {
      key: "draft",
      label: "Created",
      icon: "draft",
      tone: "neutral",
      state: "done",
      at: broadcast.created_at,
    },
  ]
  if (broadcast.scheduled_at) {
    steps.push({
      key: "scheduled",
      label: "Scheduled",
      icon: "scheduled",
      tone: "neutral",
      state: broadcast.status === "scheduled" ? "current" : "done",
      at: broadcast.scheduled_at,
    })
  }
  if (broadcast.status === "canceled") {
    steps.push({
      key: "canceled",
      label: "Canceled",
      icon: "canceled",
      tone: "neutral",
      state: "done",
      note: "Never sent",
    })
    return steps
  }
  const recipients =
    broadcast.recipient_count === null
      ? undefined
      : `${broadcast.recipient_count.toLocaleString("en")} recipient${broadcast.recipient_count === 1 ? "" : "s"}`
  steps.push({
    key: "sending",
    label: "Sending",
    icon: "sent",
    tone: "info",
    state:
      broadcast.status === "sending"
        ? "current"
        : broadcast.status === "sent"
          ? "done"
          : "pending",
    ...(recipients ? { note: recipients } : {}),
  })
  steps.push({
    key: "sent",
    label: "Sent",
    icon: "delivered",
    tone: "success",
    state: broadcast.status === "sent" ? "done" : "pending",
    ...(broadcast.sent_at ? { at: broadcast.sent_at } : {}),
  })
  return steps
}
