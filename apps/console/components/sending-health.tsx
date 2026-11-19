"use client"

import * as React from "react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Status } from "@/components/status"
import { Stat } from "@/components/stat"
import { PanelError } from "@/components/panel-error"
import { formatRate } from "@/lib/format"
import type { SendingFinding, SendingHealth, SendingStatus } from "@/lib/types"
import { Time } from "@/components/time"

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
 * The overview's sending-health card: the state, why, and seven days of rates.
 *
 * ⚠ THE THRESHOLDS ARE SES'S, as on the overview's stat row: 4% hard bounces
 * and 0.08% complaints are where Amazon starts reviewing. Soft bounces have no
 * SES line; they are shown so a list going stale is visible before it becomes
 * hard bounces.
 */
export function SendingHealthCard({
  health,
  error,
  loading = false,
  flagged = false,
}: {
  health?: SendingHealth
  error?: string
  loading?: boolean
  /** Loading only: the shape says sending is flagged, so the body will list a finding. */
  flagged?: boolean
}) {
  if (error) {
    return <PanelError title="Could not load your sending health" message={error} />
  }

  const h = health

  return (
    <BoneScope id="sending-health" loading={loading}>
      <section className="overflow-hidden rounded-2xl border">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-medium">Sending health</h2>
          {/* 22, the pill's own height: a 20px bone left the card 2px short. */}
          <Bone id="status" shape="box" width={76} height={22} radius={9999} inline>
            {h && <Status status={h.health} variant="pill" />}
          </Bone>
        </header>

        {/*
         * ⚠ THE WHOLE BODY IS ONE BONE: whether there is a reason or findings is the data's.
         *
         * ⚠ ITS HEIGHT IS THE SHAPE'S BEST GUESS (2026-11-09). Healthy, the body
         * is the one summary line; flagged (the overview's status banner), it is
         * that line and a finding card, 90px: three 22px bars 12px apart. A flat
         * two lines drew 40px for both and the page jumped 20 or 50px.
         */}
        <div className="px-4 py-3">
          <Bone
            id="summary"
            lines={flagged ? 3 : 1}
            lineHeight={flagged ? 22 : 20}
            width="80%"
            className="space-y-3"
          >
            {h && (
              <>
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
              </>
            )}
          </Bone>
        </div>

        <div className="grid grid-cols-2 divide-x divide-y border-t md:grid-cols-4 md:divide-y-0">
          <Stat
            label={h ? `Sent, last ${h.window_days} days` : "Sent, last 7 days"}
            value={h?.sends}
            loading={loading}
          />
          <Stat
            label="Bounce rate"
            value={h ? formatRate(h.hard_bounces, h.sends) : undefined}
            sub={h ? `${h.hard_bounces} hard bounces` : ""}
            tone={(h?.bounce_rate ?? 0) >= 0.04 ? "danger" : undefined}
            loading={loading}
          />
          <Stat
            label="Soft bounce rate"
            value={h ? formatRate(h.soft_bounces, h.sends) : undefined}
            sub={h ? `${h.soft_bounces} soft bounces` : ""}
            loading={loading}
          />
          <Stat
            label="Complaint rate"
            value={h ? formatRate(h.complaints, h.sends) : undefined}
            sub={h ? `${h.complaints} complaints` : ""}
            tone={(h?.complaint_rate ?? 0) >= 0.0008 ? "danger" : undefined}
            loading={loading}
          />
        </div>
      </section>
    </BoneScope>
  )
}

function Finding({ finding }: { finding: SendingFinding }) {
  return (
    <li className="rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Status status={finding.impact} />
        <span className="text-sm font-medium">{findingReason(finding.type)}</span>
        <span className="text-xs text-muted-foreground">
          <Time iso={finding.opened_at} />
        </span>
      </div>
      {finding.description ? (
        <p className="mt-1 text-xs text-muted-foreground">{finding.description}</p>
      ) : null}
    </li>
  )
}
