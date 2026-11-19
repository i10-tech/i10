"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Progress } from "@repo/ui/components/progress/progress"
import { UsageMeter } from "@repo/ui/components/usage-meter/usage-meter"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { cn } from "cn"
import { PanelError } from "@/components/panel-error"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { formatBytes, formatNumber, formatUntil } from "@/lib/format"
import { seatsLine } from "@/lib/invitations"
import {
  FEATURE_PX,
  usageShape,
  type UsageData,
  type UsageShape,
} from "@/lib/shapes/usage"
import type { FeatureUsage, SendingLimit } from "@/lib/types"

export function UsageLoading() {
  return <UsageView shape={useRememberedShape(usageShape)} />
}

export function UsageView({ shape, data }: { shape: UsageShape; data?: UsageData }) {
  const loading = data === undefined
  const limits = data?.limits ?? NONE
  const billing = data?.billing
  const members = data?.members ?? null
  const held = data?.usage.filter((feature) => feature.feature_id !== "emails") ?? []
  // Rows to draw: the data's, or as many placeholders as the shape remembers.
  const limitRows: (SendingLimit | undefined)[] = loading
    ? Array.from({ length: shape.limits }, () => undefined)
    : limits
  const featureRows: (FeatureUsage | undefined)[] = loading
    ? Array.from({ length: shape.featureKinds.length }, () => undefined)
    : held

  return (
    <BoneScope id="usage" loading={loading}>
      {data?.error !== undefined ? (
        <PanelError title="Could not load your usage" message={data.error} />
      ) : (
        <div>
          <Section className="pt-0">
            <SectionTitle>Sending limits</SectionTitle>
            <SectionDescription>
              <Bone id="blurb" lines={2} lineHeight={20} width="90%">
                {data && (
                  <>
                    {billing?.plan
                      ? `You are on ${billing.plan.name}.`
                      : "No plan is assigned to this workspace yet."}{" "}
                    A send is refused when any one of these is reached.{" "}
                    {limits.some((limit) => limit.source === "tier")
                      ? "Each limit starts with your first send and runs a full day or month from there."
                      : "Your allowance renews with your billing period."}
                  </>
                )}
              </Bone>
            </SectionDescription>
            <SectionContent className="max-w-2xl divide-y divide-border">
              {limitRows.map((limit, i) => (
                <BoneScope
                  key={limit ? `${limit.window}:${limit.count}` : i}
                  id={`limit-${i}`}
                  unit
                >
                  <LimitRow limit={limit} />
                </BoneScope>
              ))}
            </SectionContent>
          </Section>

          <Section>
            <SectionTitle>Workspace</SectionTitle>
            <SectionContent className="max-w-2xl space-y-6">
              {/* Emails are the limits above; the rest are what the workspace holds. */}
              {/* Members, pending invitations and free spots (#327); null without a team. */}
              {shape.members && (
                /*
                 * ⚠ MEMBERS AND INVITATIONS SHARE ONE BAR (#327), because both hold
                 * a spot: Clerk counts pending invitations against the limit, so a
                 * workspace with room for members can still be full.
                 */
                <Bone
                  id="members"
                  shape="box"
                  width="100%"
                  height={52}
                  radius={8}
                  className="space-y-1.5"
                >
                  {members && (
                    <>
                      <UsageMeter
                        label="Members"
                        limit={members.limit}
                        decimals={0}
                        freeLabel="Free spots"
                        warnAt={0.8}
                        segments={[
                          { id: "members", label: "Members", value: members.members },
                          {
                            id: "invitations",
                            label: "Invitations",
                            value: members.invitations,
                          },
                        ]}
                      />
                      <p className="tabular text-xs text-muted-foreground">
                        {seatsLine(members)}
                      </p>
                    </>
                  )}
                </Bone>
              )}

              {featureRows.map((feature, i) => (
                <BoneScope key={feature?.feature_id ?? i} id={`feat-${i}`} unit>
                  {/* ⚠ ONE BONE PER FEATURE, SIZED BY ITS LAYOUT: which one it takes follows its status and allowance (featureKind), and the shape remembers it. */}
                  <Bone
                    id="feature"
                    shape="box"
                    width="100%"
                    height={FEATURE_PX[shape.featureKinds[i] ?? "line"]}
                    radius={8}
                  >
                    {feature && <FeatureRow feature={feature} />}
                  </Bone>
                </BoneScope>
              ))}
            </SectionContent>
          </Section>

          <Section>
            <SectionTitle>Need more?</SectionTitle>
            <SectionContent>
              <ButtonLink href="/settings/billing">See plans</ButtonLink>
            </SectionContent>
          </Section>
        </div>
      )}
      {data && data.error === undefined && (
        <RememberShape def={usageShape} shape={shape} />
      )}
    </BoneScope>
  )
}

// ⚠ ITS BRANCHES ARE `featureKind`'S (lib/shapes/usage.ts): change one, change both.
function FeatureRow({ feature }: { feature: FeatureUsage }) {
  if (feature.status === "unreadable") {
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">{feature.label}</span>
          <span className="text-sm text-muted-foreground">-</span>
        </div>
        <p className="text-xs text-muted-foreground">
          We could not read this right now. Your sending is unaffected.
        </p>
      </div>
    )
  }

  if (feature.status === "unentitled") {
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">{feature.label}</span>
          <span className="text-sm text-muted-foreground">Not on your plan</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Your plan grants no allowance for this. If that looks wrong, it probably is -
          tell us.
        </p>
      </div>
    )
  }

  // A zero allowance is not a quota that is full: the plan has none.
  if (feature.allowance === 0) {
    return (
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{feature.label}</span>
        <span className="text-sm text-muted-foreground">Not on your plan</span>
      </div>
    )
  }

  // No allowance means no ceiling: show the amount, not a bar.
  if (feature.allowance === null) {
    return (
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{feature.label}</span>
        <span className="tabular text-sm text-muted-foreground">
          {feature.unit === "bytes"
            ? formatBytes(feature.used)
            : formatNumber(feature.used)}{" "}
          used, no limit
        </span>
      </div>
    )
  }

  const allowance = feature.allowance

  return (
    <UsageMeter
      label={feature.label}
      limit={feature.unit === "bytes" ? allowance / 1e9 : allowance}
      unit={feature.unit === "bytes" ? "GB" : ""}
      decimals={feature.unit === "bytes" ? 1 : 0}
      segments={[
        {
          id: "used",
          label: "Used",
          value: feature.unit === "bytes" ? feature.used / 1e9 : feature.used,
        },
      ]}
    />
  )
}

const WINDOW_NAME: Record<SendingLimit["window"], [single: string, plural: string]> = {
  day: ["Daily", "days"],
  week: ["Weekly", "weeks"],
  month: ["Monthly", "months"],
  year: ["Yearly", "years"],
  lifetime: ["Lifetime", "lifetime"],
}

function windowLabel({ window, count }: SendingLimit): string {
  const [single, plural] = WINDOW_NAME[window]
  return count === 1 ? `${single} limit` : `Every ${count} ${plural}`
}

const TIER_NAME: Record<string, string> = {
  normal: "Normal tier",
  strict: "Strict tier",
}

/**
 * One window: its name and when it resets on the left, the bar in the middle,
 * how much is used on the right - the shape of Claude's usage rows.
 *
 * ⚠ A PERCENTAGE FIRST, THE COUNT UNDER IT. "62% used" is what somebody reads
 * at a glance; "62 / 100" is what they check before a big send.
 */
function LimitRow({ limit }: { limit?: SendingLimit }) {
  const label = limit ? windowLabel(limit) : ""

  const detail = !limit
    ? ""
    : limit.status === "unreadable"
      ? "Could not be read right now. Your sending is unaffected."
      : [
          limit.tier ? (TIER_NAME[limit.tier] ?? limit.tier) : null,
          limit.starts_on_send
            ? "Starts with your next send"
            : limit.resets_at
              ? `Resets in ${formatUntil(limit.resets_at)}`
              : null,
        ]
          .filter(Boolean)
          .join(" · ")

  const allowance = limit?.allowance ?? null
  const pct = limit && allowance ? Math.round((limit.used / allowance) * 100) : 0
  // Past the line with overage; AT it on a hard cap, where sends are refused.
  const over =
    limit !== undefined &&
    allowance !== null &&
    (limit.overage ? limit.used > allowance : limit.used >= allowance)

  return (
    <div className="grid grid-cols-1 gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,13rem)_1fr_6rem] sm:items-center sm:gap-6">
      <div className="min-w-0 space-y-1">
        <Bone id="label" width={90} lineHeight={20}>
          {limit && <p className="text-sm font-medium">{label}</p>}
        </Bone>
        <Bone id="detail" width={140} lineHeight={16}>
          {limit && detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </Bone>
      </div>

      {/* ⚠ ONE BONE FOR BOTH COLUMNS: an unreadable window or one with no ceiling shows a line of text, not a bar. */}
      <div className="sm:col-span-2">
        <Bone id="reading" shape="box" width="100%" height={36} radius={8}>
          {limit &&
            (limit.status === "unreadable" ? (
              <span className="text-sm text-muted-foreground">-</span>
            ) : allowance === null ? (
              <span className="text-sm text-muted-foreground">
                No {WINDOW_NAME[limit.window][0].toLowerCase()} limit
              </span>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_6rem] sm:items-center sm:gap-6">
                <Progress
                  value={limit.used}
                  max={allowance}
                  aria-label={`${label}: ${pct}% used`}
                />
                <div className="tabular text-sm sm:text-right">
                  <p className={cn(over && !limit.overage && "text-danger")}>
                    {pct}% used
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(limit.used)} / {formatNumber(allowance)}
                  </p>
                  {over && (
                    <p
                      className={cn(
                        "text-xs",
                        limit.overage ? "text-muted-foreground" : "text-danger",
                      )}
                    >
                      {limit.overage
                        ? `${formatNumber(limit.used - allowance)} billed as overage`
                        : "Limit reached"}
                    </p>
                  )}
                </div>
              </div>
            ))}
        </Bone>
      </div>
    </div>
  )
}
