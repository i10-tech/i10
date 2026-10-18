import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { ArrowUpRight } from "lucide-react"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  Page,
  PageBody,
  PageActions,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { Status } from "@/components/status"
import { OverviewChart } from "@/components/overview-chart"
import { ApiButton } from "@/components/list/api-button"
import { RangePicker } from "@/components/range-picker"
import { Stat } from "@/components/stat"
import { KpiRow, share } from "@/components/kpi-row"
import { TrendCard } from "@/components/trend-card"
import { PanelError } from "@/components/panel-error"
import { SendingHealthCard } from "@/components/sending-health"
import { SendingStatusBanner } from "@/components/sending-status-banner"
import { CapacityBanner } from "@/components/capacity-banner"
import { JoinSuggestions } from "@/components/join-suggestions"
import { tryApi } from "@/lib/api"
import { formatRelative, bareAddress } from "@/lib/format"
import { SNIPPETS } from "@/lib/snippets"
import type { DailyStat, EmailRow, Overview, Page as ApiPage } from "@/lib/types"

export const metadata: Metadata = { title: "Overview" }

/**
 * The first screen after signing in.
 *
 * ⚠ IT ANSWERS "IS MY MAIL GOING OUT", AND NOTHING ELSE. Every panel here is
 * either a number that would make somebody act or a shortcut to the page where
 * they would act. Resource counts that change monthly - how many domains, how
 * many keys - are a row of small links at the bottom rather than the headline,
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
  // offer - `?days=7000` would otherwise show no option as active.
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
            <ApiButton snippet={SNIPPETS.emails} />
          </PageActions>
        </PageHeaderRow>
      </PageHeader>

      <PageBody className="space-y-6">
        {/* What the rail's sending notice links to. Nothing when healthy. */}
        <Suspense fallback={null}>
          <SendingStatusBanner />
        </Suspense>
        {/* Admins only, at 80% and 100% of the member limit (#327). */}
        <Suspense fallback={null}>
          <CapacityBanner />
        </Suspense>
        {/*
         * Workspaces this person is suggested or invited to (2026-10-12).
         * Clerk's hooks need its provider, which needs a key.
         */}
        {process.env.CLERK_PUBLISHABLE_KEY && <JoinSuggestions />}

        {!overview.ok ? (
          <PanelError
            title="Could not load your metrics"
            message={overview.error.message}
          />
        ) : (
          <>
            <KpiRow>
              {(() => {
                const { totals, series } = overview.data
                const dates = series.map((d) => d.date)
                const pointsOf = (key: Exclude<keyof DailyStat, "date">) =>
                  series.map((d) => d[key])
                return (
                  <>
                    <TrendCard
                      label="Sent"
                      value={totals.sent}
                      points={pointsOf("sent")}
                      dates={dates}
                      context={`Last ${days} days`}
                    />
                    <TrendCard
                      label="Delivered"
                      value={totals.delivered}
                      points={pointsOf("delivered")}
                      dates={dates}
                      context={`${share(totals.delivered, totals.sent)}% of sent`}
                    />
                    <TrendCard
                      label="Bounced"
                      value={totals.bounced}
                      points={pointsOf("bounced")}
                      dates={dates}
                      context={`${share(totals.bounced, totals.sent)}% of sent`}
                      // ⚠ 4% IS SES'S THRESHOLD, NOT A NUMBER PICKED FOR THE
                      // COLOUR. Above it Amazon reviews the account and
                      // eventually pauses sending, so that is when somebody
                      // has to act.
                      warning={
                        totals.sent > 0 && totals.bounced / totals.sent >= 0.04
                          ? "Over 4%"
                          : undefined
                      }
                    />
                    <TrendCard
                      label="Complained"
                      value={totals.complained}
                      points={pointsOf("complained")}
                      dates={dates}
                      context={`${share(totals.complained, totals.sent)}% of sent`}
                      // ⚠ 0.08% IS THE COMPLAINT THRESHOLD, AND IT IS TINY.
                      // Three complaints in four thousand sends is already the
                      // line.
                      warning={
                        totals.sent > 0 && totals.complained / totals.sent >= 0.0008
                          ? "Over 0.08%"
                          : undefined
                      }
                    />
                    <TrendCard
                      label="Delayed"
                      value={totals.delayed}
                      points={pointsOf("delayed")}
                      dates={dates}
                      context={`Last ${days} days`}
                    />
                    <TrendCard
                      label="Failed"
                      value={totals.failed}
                      points={pointsOf("failed")}
                      dates={dates}
                      context={`Last ${days} days`}
                    />
                  </>
                )
              })()}
            </KpiRow>

            {/*
             * ⚠ ALWAYS SHOWN, GREEN WHEN ALL IS WELL (#158). The seven-day
             * window is SES's, not the range picker's: it is the window a
             * pause is judged on, whatever range the chart is showing.
             */}
            <SendingHealthCard />

            <section className="rounded-2xl border p-4">
              <h2 className="mb-3 text-sm font-medium">Delivery</h2>
              <OverviewChart series={overview.data.series} />
            </section>
          </>
        )}

        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <section className="min-w-0 rounded-2xl border">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-medium">Recent sends</h2>
              <ButtonLink href="/emails" variant="ghost" size="sm">
                View all
                <ArrowUpRight />
              </ButtonLink>
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
                  Your first send will appear here within a second of the API accepting
                  it.
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
                       * chart, so the word does not fit - but `Status` renders
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
                        {email.subject || (
                          <em className="text-muted-foreground">No subject</em>
                        )}
                      </span>
                      <span className="hidden min-w-0 shrink-0 truncate font-mono text-xs text-muted-foreground sm:block sm:max-w-[14rem]">
                        {email.to[0] ? bareAddress(email.to[0]) : "-"}
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
              <div className="divide-y overflow-hidden rounded-2xl border">
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

            <div className="rounded-2xl border p-4">
              <h2 className="text-sm font-medium">Set-up</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a domain, publish its records and send a test - the same flow you
                saw on your first visit, available whenever you need it.
              </p>
              <ButtonLink
                href="/onboarding"
                variant="secondary"
                size="sm"
                className="mt-3"
              >
                Open set-up
              </ButtonLink>
            </div>
          </section>
        </div>
      </PageBody>
    </Page>
  )
}
