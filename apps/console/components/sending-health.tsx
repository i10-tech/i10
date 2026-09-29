import Link from "next/link"
import { Status } from "@/components/status"
import { Stat } from "@/components/stat"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatRate, formatRelative } from "@/lib/format"
import type { SendingFinding, SendingHealth, SendingStatus } from "@/lib/types"

/**
 * What a finding type means, in the customer's words (#158).
 *
 * ⚠ SES'S OWN SENTENCE IS SHOWN UNDER THIS, NOT INSTEAD OF IT. "The bounce rate
 * exceeded 15.0% based on 664 emails" is precise and worth keeping, but it
 * assumes the reader knows what a bounce rate is for; this line says what to
 * look at.
 */
export function findingReason(type: string): string {
  switch (type) {
    case "bounce":
      return "Too many recent emails bounced."
    case "complaint":
      return "Too many recipients marked recent emails as spam."
    case "feedback_3p":
      return "Mailbox providers reported problems with recent mail."
    case "ip_listing":
      return "A sending address appeared on a spam blocklist."
    default:
      return "Our email provider flagged recent mail."
  }
}

const SUMMARY: Record<SendingStatus["health"], string> = {
  healthy: "Bounces and complaints are within our email provider's limits.",
  at_risk:
    "Our email provider flagged recent mail. Sending still works, but it will be paused if this continues.",
  paused:
    "Our email provider paused sending. The API refuses new emails until it is lifted.",
  held: "Sending is on hold while we review this workspace. A person will look within a day.",
}

/**
 * The workspace's sending health in the sidebar, on every page (#158).
 *
 * ⚠ SHOWN WHEN IT IS GOOD, NOT ONLY WHEN IT IS BAD. A green "Healthy" that is
 * always there is what makes the amber one noticed when it changes - and it
 * answers "is anything wrong with my sending" without a click, which is the
 * question a customer asks most.
 *
 * ⚠ AND A FAILED READ RENDERS NOTHING, like the usage rail beside it. Ambient
 * furniture must never be the thing that alarms somebody.
 */
export async function SendingHealthRail() {
  const result = await tryApi<SendingStatus>("/console/sending-status")
  if (!result.ok) return null
  return (
    <Link
      href="/"
      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-muted/40"
    >
      <span className="text-xs font-medium text-muted-foreground">Sending</span>
      <Status status={result.data.health} variant="pill" />
    </Link>
  )
}

/**
 * The overview's sending-health card: the state, why, and seven days of rates.
 *
 * ⚠ THE THRESHOLDS ARE SES'S, as on the overview's stat row: 4% hard bounces
 * and 0.08% complaints are where Amazon starts reviewing. Soft bounces have no
 * SES line; they are shown so a list going stale is visible before it becomes
 * hard bounces.
 */
export async function SendingHealthCard() {
  const result = await tryApi<SendingHealth>("/console/sending-health")
  if (!result.ok) {
    return (
      <PanelError
        title="Could not load your sending health"
        message={result.error.message}
      />
    )
  }
  const h = result.data

  return (
    <section className="overflow-hidden rounded-lg border">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-medium">Sending health</h2>
        <Status status={h.health} variant="pill" />
      </header>

      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-muted-foreground">{SUMMARY[h.health]}</p>
        {h.health === "paused" && h.cause ? (
          <p className="text-sm">The reason given: {h.cause}</p>
        ) : null}
        {h.findings.length > 0 ? (
          <ul className="space-y-2">
            {h.findings.map((f) => (
              <Finding key={`${f.type}:${f.impact}`} finding={f} />
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid grid-cols-2 divide-x divide-y border-t md:grid-cols-4 md:divide-y-0">
        <Stat label={`Sent, last ${h.window_days} days`} value={h.sends} />
        <Stat
          label="Bounce rate"
          value={formatRate(h.hard_bounces, h.sends)}
          sub={`${h.hard_bounces} hard bounces`}
          tone={(h.bounce_rate ?? 0) >= 0.04 ? "danger" : undefined}
        />
        <Stat
          label="Soft bounce rate"
          value={formatRate(h.soft_bounces, h.sends)}
          sub={`${h.soft_bounces} soft bounces`}
        />
        <Stat
          label="Complaint rate"
          value={formatRate(h.complaints, h.sends)}
          sub={`${h.complaints} complaints`}
          tone={(h.complaint_rate ?? 0) >= 0.0008 ? "danger" : undefined}
        />
      </div>
    </section>
  )
}

function Finding({ finding }: { finding: SendingFinding }) {
  return (
    <li className="rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Status status={finding.impact} />
        <span className="text-sm font-medium">{findingReason(finding.type)}</span>
        <span className="text-xs text-muted-foreground">
          {formatRelative(finding.opened_at)}
        </span>
      </div>
      {finding.description ? (
        <p className="mt-1 text-xs text-muted-foreground">{finding.description}</p>
      ) : null}
    </li>
  )
}
