import type { Metadata } from "next"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  Page,
  PageBody,
  PageActions,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { Status } from "@/components/status"
import { OverviewChart } from "@/components/overview-chart"
import { RangePicker } from "@/components/range-picker"
import { Stat, StatRow } from "@/components/stat"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatRate, formatRelative, bareAddress } from "@/lib/format"
import type { EmailRow, Overview, Page as ApiPage } from "@/lib/types"

export const metadata: Metadata = { title: "Overview" }

/**
 * The first screen after signing in.
 *
 * ⚠ IT ANSWERS "IS MY MAIL GOING OUT", AND NOTHING ELSE. Every panel here is
 * either a number that would make somebody act or a shortcut to the page where
 * they would act. Resource counts that change monthly — how many domains, how
 * many keys — are a row of small links at the bottom rather than the headline,
 * because a dashboard whose largest number is "3 domains" has buried the only
 * number that matters today.
 *
 * ⚠ AND THE TWO FETCHES ARE INDEPENDENT AND FAIL INDEPENDENTLY. A slow or
 * broken recent-sends query must not blank the chart, and vice versa: server
 * components have no error-boundary granularity below `error.tsx` for the whole
 * route, so the granularity has to be `tryApi` per panel.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const params = await searchParams
  // ⚠ CLAMPED HERE AS WELL AS ON THE API. The API clamps because it must; this
  // clamps so the picker never renders a selected state for a value it does not
  // offer — `?days=7000` would otherwise show no option as active.
  const days = [7, 14, 30, 90].includes(Number(params.days)) ? Number(params.days) : 30

  const [overview, recent] = await Promise.all([
    tryApi<Overview>("/console/overview", { query: { days } }),
    tryApi<ApiPage<EmailRow>>("/console/emails", { query: { limit: 8 } }),
  ])

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Overview</PageTitle>
          <PageActions>
            <RangePicker value={days} />
          </PageActions>
        </PageHeaderRow>
      </PageHeader>

      <PageBody className="space-y-6">
        {!overview.ok ? (
          <PanelError title="Could not load your metrics" message={overview.error.message} />
        ) : (
          <>
            <StatRow>
              <Stat label="Sent" value={overview.data.totals.sent} />
              <Stat
                label="Delivered"
                value={overview.data.totals.delivered}
                sub={formatRate(
                  overview.data.totals.delivered,
                  overview.data.totals.sent,
                )}
              />
              <Stat
                label="Bounced"
                value={overview.data.totals.bounced}
                tone={
                  /*
                   * ⚠ 4% IS SES'S THRESHOLD, NOT A NUMBER PICKED FOR THE
                   * COLOUR. Above it, Amazon puts the account under review and
                   * eventually pauses sending — so this is the point at which
                   * somebody has to act, which is exactly what a warning
                   * colour should mean. Below it, the number is neutral
                   * however large it looks.
                   */
                  overview.data.totals.sent > 0 &&
                  overview.data.totals.bounced / overview.data.totals.sent >= 0.04
                    ? "danger"
                    : undefined
                }
                sub={formatRate(overview.data.totals.bounced, overview.data.totals.sent)}
              />
              <Stat
                label="Complained"
                value={overview.data.totals.complained}
                tone={
                  // ⚠ 0.08% IS THE COMPLAINT THRESHOLD, AND IT IS TINY. Three
                  // complaints in four thousand sends is already the line.
                  overview.data.totals.sent > 0 &&
                  overview.data.totals.complained / overview.data.totals.sent >= 0.0008
                    ? "danger"
                    : undefined
                }
                sub={formatRate(
                  overview.data.totals.complained,
                  overview.data.totals.sent,
                )}
              />
              <Stat label="Delayed" value={overview.data.totals.delayed} />
              <Stat
                label="Failed"
                value={overview.data.totals.failed}
                tone={overview.data.totals.failed > 0 ? "warning" : undefined}
              />
            </StatRow>

            <section className="rounded-lg border p-4">
              <h2 className="mb-3 text-sm font-medium">Delivery</h2>
              <OverviewChart series={overview.data.series} />
            </section>
          </>
        )}

        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <section className="min-w-0 rounded-lg border">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-medium">Recent sends</h2>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/emails">
                  View all
                  <ArrowUpRight />
                </Link>
              </Button>
            </header>

            {!recent.ok ? (
              <PanelError
                title="Could not load recent sends"
                message={recent.error.message}
                bare
              />
            ) : recent.data.data.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm font-medium">Nothing sent yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Your first send will appear here within a second of the API
                  accepting it.
                </p>
              </div>
            ) : (
              <ul className="divide-y">
                {recent.data.data.map((email) => (
                  <li key={email.id}>
                    <Link
                      href={`/emails/${email.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:bg-muted/40"
                    >
                      {/*
                       * ⚠ THE LABEL IS VISUALLY HIDDEN HERE AND ONLY HERE, AND
                       * IT IS STILL IN THE DOM. This is a narrow panel beside a
                       * chart, so the word does not fit — but `Status` renders
                       * the state as a coloured dot, and a dot with no text is
                       * invisible to a screen reader AND to the roughly one man
                       * in twelve who cannot separate the green from the red.
                       * `sr-only` keeps the word for both. Dropping it would
                       * have made the one accessible half of that component
                       * disappear.
                       */}
                      <Status
                        status={email.last_event}
                        label={<span className="sr-only">{email.last_event}</span>}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {email.subject || <em className="text-muted-foreground">No subject</em>}
                      </span>
                      <span className="hidden min-w-0 shrink-0 truncate font-mono text-xs text-muted-foreground sm:block sm:max-w-[14rem]">
                        {email.to[0] ? bareAddress(email.to[0]) : "—"}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelative(email.created_at)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            {overview.ok && (
              <div className="divide-y overflow-hidden rounded-lg border">
                <Stat
                  label="Domains"
                  value={`${overview.data.counts.verifiedDomains} / ${overview.data.counts.domains}`}
                  sub="verified"
                  href="/domains"
                />
                <Stat
                  label="API keys"
                  value={overview.data.counts.apiKeys}
                  sub="active"
                  href="/api-keys"
                />
                <Stat
                  label="Webhook endpoints"
                  value={overview.data.counts.webhookEndpoints}
                  href="/webhooks"
                />
                <Stat
                  label="Suppressed addresses"
                  value={overview.data.counts.suppressions}
                  href="/suppressions"
                />
              </div>
            )}

            <div className="rounded-lg border p-4">
              <h2 className="text-sm font-medium">Set-up</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a domain, publish its records and send a test — the same flow
                you saw on your first visit, available whenever you need it.
              </p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <Link href="/onboarding">Open set-up</Link>
              </Button>
            </div>
          </section>
        </div>
      </PageBody>
    </Page>
  )
}
