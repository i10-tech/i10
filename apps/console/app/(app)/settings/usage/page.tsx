import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@repo/ui/components/button"
import { Meter, MeterRow } from "@repo/ui/components/meter"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { cn } from "cn"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatBytes, formatNumber, formatUntil } from "@/lib/format"
import type { BillingState, FeatureUsage, SendingLimit } from "@/lib/types"

export const metadata: Metadata = { title: "Usage" }

/**
 * What this workspace has consumed.
 *
 * ⚠ THE NUMBERS COME FROM THE SAME METER THAT ENFORCES THE LIMIT. A separate
 * read-side query would drift from the one the send path uses, and the failure
 * mode is specific and awful: a dashboard showing 40,000 of 50,000 while
 * sending is being refused.
 *
 * ⚠ SENDING IS SHOWN AS ONE ROW PER WINDOW, LIKE CLAUDE'S SESSION AND WEEKLY
 * LIMITS. A free workspace can be refused by its day OR its month, so both are
 * on screen together; a paid one sees its month and a daily row that says it
 * has no daily limit, so the page reads the same for everybody.
 *
 * ⚠ AND `unentitled` IS RENDERED AS ITSELF, NEVER AS "0 of 0". It means the
 * plan grants nothing for that feature - which is almost always OUR
 * misconfiguration. Showing a full meter would tell a customer who has sent
 * nothing to go and upgrade, and they would, which makes our bug invisible to
 * us.
 */
export default async function UsagePage() {
  const result = await tryApi<{
    usage: FeatureUsage[]
    limits: SendingLimit[]
    billing: BillingState
  }>("/console/usage")

  if (!result.ok) {
    return (
      <PanelError title="Could not load your usage" message={result.error.message} />
    )
  }

  const { usage, limits, billing } = result.data
  // Emails are the limits above; the rest are what the workspace holds.
  const held = usage.filter((feature) => feature.feature_id !== "emails")

  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Sending limits</SectionTitle>
        <SectionDescription>
          {billing.plan
            ? `You are on ${billing.plan.name}.`
            : "No plan is assigned to this workspace yet."}{" "}
          A send is refused when any one of these is reached. Each resets on a rolling
          window from when your plan started, not on the first of the month.
        </SectionDescription>
        <SectionContent className="max-w-2xl divide-y divide-border">
          {limits.map((limit) => (
            <LimitRow key={`${limit.window}:${limit.count}`} limit={limit} />
          ))}
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Workspace</SectionTitle>
        <SectionContent className="max-w-2xl space-y-6">
          {held.map((feature) => {
            if (feature.status === "unreadable") {
              return (
                <div key={feature.feature_id} className="space-y-1">
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
                <div key={feature.feature_id} className="space-y-1">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">{feature.label}</span>
                    <span className="text-sm text-muted-foreground">
                      Not on your plan
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your plan grants no allowance for this. If that looks wrong, it
                    probably is - tell us.
                  </p>
                </div>
              )
            }

            return (
              <MeterRow
                key={feature.feature_id}
                label={feature.label}
                used={feature.used}
                limit={feature.allowance}
                overage={feature.overage}
                format={
                  feature.unit === "bytes"
                    ? (n) => formatBytes(n)
                    : (n) => formatNumber(n)
                }
              />
            )
          })}
        </SectionContent>
      </Section>

      <Section>
        <SectionTitle>Need more?</SectionTitle>
        <SectionContent>
          <Button asChild>
            <Link href="/settings/billing">See plans</Link>
          </Button>
        </SectionContent>
      </Section>
    </div>
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
function LimitRow({ limit }: { limit: SendingLimit }) {
  const label = windowLabel(limit)

  const detail =
    limit.status === "unreadable"
      ? "Could not be read right now. Your sending is unaffected."
      : [
          limit.tier ? (TIER_NAME[limit.tier] ?? limit.tier) : null,
          limit.resets_at ? `Resets in ${formatUntil(limit.resets_at)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")

  const allowance = limit.allowance
  const pct = allowance ? Math.round((limit.used / allowance) * 100) : 0
  const over = allowance !== null && limit.used > allowance

  return (
    <div className="grid grid-cols-1 gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,13rem)_1fr_6rem] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>

      {limit.status === "unreadable" ? (
        <span className="text-sm text-muted-foreground sm:col-span-2">-</span>
      ) : allowance === null ? (
        <span className="text-sm text-muted-foreground sm:col-span-2">
          No {WINDOW_NAME[limit.window][0].toLowerCase()} limit
        </span>
      ) : (
        <>
          <Meter used={limit.used} limit={allowance} overage={limit.overage} />
          <div className="tabular text-sm sm:text-right">
            <p className={cn(over && !limit.overage && "text-danger")}>{pct}% used</p>
            <p className="text-xs text-muted-foreground">
              {formatNumber(limit.used)} / {formatNumber(allowance)}
            </p>
            {/*
              ⚠ PAST THE LINE, SAY WHICH KIND OF PAST IT IS. On overage it is an
              invoice line, on a cap it is a wall - the same bar means opposite
              things, and the words are what tell them apart.
            */}
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
        </>
      )}
    </div>
  )
}
