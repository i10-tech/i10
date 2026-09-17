import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@repo/ui/components/button"
import { MeterRow } from "@repo/ui/components/meter"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatBytes, formatExact, formatNumber } from "@/lib/format"
import type { BillingState, FeatureUsage } from "@/lib/types"

export const metadata: Metadata = { title: "Usage" }

/**
 * What this workspace has consumed.
 *
 * ⚠ THE NUMBERS COME FROM THE SAME METER THAT ENFORCES THE LIMIT. A separate
 * read-side query would drift from the one the send path uses, and the failure
 * mode is specific and awful: a dashboard showing 40,000 of 50,000 while
 * sending is being refused.
 *
 * ⚠ AND `unentitled` IS RENDERED AS ITSELF, NEVER AS "0 of 0". It means the
 * plan grants nothing for that feature — which is almost always OUR
 * misconfiguration. Showing a full meter would tell a customer who has sent
 * nothing to go and upgrade, and they would, which makes our bug invisible to
 * us.
 */
export default async function UsagePage() {
  const result = await tryApi<{ usage: FeatureUsage[]; billing: BillingState }>(
    "/console/usage",
  )

  if (!result.ok) {
    return (
      <PanelError title="Could not load your usage" message={result.error.message} />
    )
  }

  const { usage, billing } = result.data

  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>This period</SectionTitle>
        <SectionDescription>
          {billing.plan
            ? `You are on ${billing.plan.name}.`
            : "No plan is assigned to this workspace yet."}{" "}
          Allowances reset on a rolling window from when your plan started, not on the
          first of the month.
        </SectionDescription>
        <SectionContent className="max-w-2xl space-y-6">
          {usage.map((feature) => {
            if (feature.status === "unreadable") {
              return (
                <div key={feature.feature_id} className="space-y-1">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">{feature.label}</span>
                    <span className="text-sm text-muted-foreground">—</span>
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
                    probably is — tell us.
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
        <SectionTitle>Reset</SectionTitle>
        <SectionContent>
          <p className="text-sm text-muted-foreground">
            {usage.find((u) => u.resets_at)?.resets_at
              ? `Your sending allowance next resets ${formatExact(
                  usage.find((u) => u.resets_at)!.resets_at!,
                )}.`
              : "Nothing in your plan resets on a schedule."}
          </p>
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
