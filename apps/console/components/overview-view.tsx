"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  Page,
  PageActions,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
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
import { RememberShape, seedShape } from "@/components/list/remembered-shapes"
import { bareAddress } from "@/lib/format"
import { SNIPPETS } from "@/lib/snippets"
import { emailShape, emailShapeFromRow } from "@/lib/shapes/email"
import {
  overviewShape,
  type OverviewData,
  type OverviewShape,
} from "@/lib/shapes/overview"
import type { DailyStat, EmailRow } from "@/lib/types"
import { Time } from "@/components/time"

const SUBJECT_WIDTHS = ["60%", "45%", "70%", "52%", "65%", "48%"]

/**
 * ⚠ ONLY THAT A BANNER IS THERE IS COMPARED BY test/skeleton-parity, NOT WHAT
 * IT SAYS. Its tone and copy follow the live status (held, paused, at risk,
 * a finding's reason), which the shape reduces to present or absent.
 */
function BannerSlot({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="contents" data-skeleton="skip">
        {children}
      </div>
    </div>
  )
}

/**
 * The overview page, loaded and loading: ONE view, so the skeleton cannot
 * drift from the live dashboard.
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (recent sends row count, advisory
 * banners, suggestions, days range); `data` fills the bones.
 */
export function OverviewView({
  shape,
  data,
}: {
  shape: OverviewShape
  data?: OverviewData
}) {
  const loading = data === undefined
  const days = shape.days

  const hasStatus = shape.banner === "status" || shape.banner === "both"
  const hasCapacity = shape.banner === "capacity" || shape.banner === "both"

  const rows: (EmailRow | undefined)[] = loading
    ? Array.from({ length: shape.recent }, () => undefined)
    : (data?.recent ?? NONE)
  const hasRows = shape.recent > 0

  const overview = data?.overview
  const totals = overview?.totals
  const series = overview?.series ?? []
  const dates = series.map((d) => d.date)
  const pointsOf = (key: Exclude<keyof DailyStat, "date">) => series.map((d) => d[key])

  return (
    <BoneScope id="overview" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text="Overview" className={TITLE} />
            ) : (
              <PageTitle>Overview</PageTitle>
            )}
            <PageActions>
              <RangePicker value={days} />
              <ApiButton snippet={SNIPPETS.emails} />
            </PageActions>
          </PageHeaderRow>
        </PageHeader>

        <PageBody className="space-y-6">
          {/* Advisory banners: their space is reserved by the shape from frame 1. */}
          {/* What the rail's sending notice links to. Nothing when healthy. */}
          {hasStatus && (
            <BannerSlot>
              <SendingStatusBanner status={data?.sendingStatus} loading={loading} />
            </BannerSlot>
          )}
          {/* Admins only, at 80% and 100% of the member limit (#327). */}
          {hasCapacity && (
            <BannerSlot>
              <CapacityBanner capacity={data?.capacity} loading={loading} />
            </BannerSlot>
          )}

          {/*
           * Workspaces this person is suggested or invited to (2026-10-12).
           * Clerk's hooks need its provider, which needs a key.
           */}
          {process.env.CLERK_PUBLISHABLE_KEY &&
            (loading ? (
              shape.suggestions ? (
                <JoinSuggestions loading={true} />
              ) : null
            ) : (
              <JoinSuggestions />
            ))}

          {!loading && data?.overviewError !== undefined ? (
            <PanelError
              title="Could not load your metrics"
              message={data.overviewError}
            />
          ) : (
            <>
              <KpiRow loading={loading}>
                <TrendCard
                  label="Sent"
                  value={totals?.sent}
                  points={totals ? pointsOf("sent") : undefined}
                  dates={totals ? dates : undefined}
                  context={`Last ${days} days`}
                  loading={loading}
                />
                <TrendCard
                  label="Delivered"
                  value={totals?.delivered}
                  points={totals ? pointsOf("delivered") : undefined}
                  dates={totals ? dates : undefined}
                  derived
                  context={
                    totals
                      ? `${share(totals.delivered, totals.sent)}% of sent`
                      : `Last ${days} days`
                  }
                  loading={loading}
                />
                <TrendCard
                  label="Bounced"
                  value={totals?.bounced}
                  points={totals ? pointsOf("bounced") : undefined}
                  dates={totals ? dates : undefined}
                  derived
                  context={
                    totals
                      ? `${share(totals.bounced, totals.sent)}% of sent`
                      : `Last ${days} days`
                  }
                  // ⚠ 4% IS SES'S THRESHOLD, NOT A NUMBER PICKED FOR THE
                  // COLOUR. Above it Amazon reviews the account and
                  // eventually pauses sending, so that is when somebody
                  // has to act.
                  warning={
                    totals && totals.sent > 0 && totals.bounced / totals.sent >= 0.04
                      ? "Over 4%"
                      : undefined
                  }
                  loading={loading}
                />
                <TrendCard
                  label="Complained"
                  value={totals?.complained}
                  points={totals ? pointsOf("complained") : undefined}
                  dates={totals ? dates : undefined}
                  derived
                  context={
                    totals
                      ? `${share(totals.complained, totals.sent)}% of sent`
                      : `Last ${days} days`
                  }
                  // ⚠ 0.08% IS THE COMPLAINT THRESHOLD, AND IT IS TINY.
                  // Three complaints in four thousand sends is already the
                  // line.
                  warning={
                    totals &&
                    totals.sent > 0 &&
                    totals.complained / totals.sent >= 0.0008
                      ? "Over 0.08%"
                      : undefined
                  }
                  loading={loading}
                />
                <TrendCard
                  label="Delayed"
                  value={totals?.delayed}
                  points={totals ? pointsOf("delayed") : undefined}
                  dates={totals ? dates : undefined}
                  context={`Last ${days} days`}
                  loading={loading}
                />
                <TrendCard
                  label="Failed"
                  value={totals?.failed}
                  points={totals ? pointsOf("failed") : undefined}
                  dates={totals ? dates : undefined}
                  context={`Last ${days} days`}
                  loading={loading}
                />
              </KpiRow>

              {/*
               * ⚠ ALWAYS SHOWN, GREEN WHEN ALL IS WELL (#158). The seven-day
               * window is SES's, not the range picker's: it is the window a
               * pause is judged on, whatever range the chart is showing.
               */}
              <SendingHealthCard
                health={data?.sendingHealth}
                error={data?.sendingHealthError}
                loading={loading}
                flagged={hasStatus}
              />

              <section className="rounded-2xl border p-4">
                <h2 className="mb-3 text-sm font-medium">Delivery</h2>
                <OverviewChart series={overview?.series} loading={loading} />
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

              {!loading && data?.recentError !== undefined ? (
                <PanelError
                  title="Could not load recent sends"
                  message={data.recentError}
                  bare
                />
              ) : !hasRows ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm font-medium">Nothing sent yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your first send will appear here within a second of the API
                    accepting it.
                  </p>
                </div>
              ) : (
                <BoneRegion id="recent-sends">
                  <ul className="divide-y">
                    {rows.map((email, i) => (
                      <BoneScope key={email?.id ?? i} id={`recent-${i}`} unit>
                        <li>
                          <Link
                            href={email ? `/emails/${email.id}` : "#"}
                            onPointerEnter={() => {
                              if (email)
                                seedShape(
                                  emailShape,
                                  email.id,
                                  emailShapeFromRow(email),
                                )
                            }}
                            onClick={() => {
                              if (email)
                                seedShape(
                                  emailShape,
                                  email.id,
                                  emailShapeFromRow(email),
                                )
                            }}
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
                            <Bone
                              id="status"
                              shape="box"
                              width={8}
                              height={8}
                              radius={9999}
                              inline
                            >
                              {email && (
                                <Status
                                  status={email.last_event}
                                  label={
                                    <span className="sr-only">{email.last_event}</span>
                                  }
                                  className="shrink-0"
                                />
                              )}
                            </Bone>
                            <Bone
                              id="subject"
                              width={SUBJECT_WIDTHS[i % SUBJECT_WIDTHS.length]}
                              className="min-w-0 flex-1 truncate text-sm"
                            >
                              {email &&
                                (email.subject || (
                                  <em className="text-muted-foreground">No subject</em>
                                ))}
                            </Bone>
                            <Bone
                              id="to"
                              width={120}
                              className="hidden min-w-0 shrink-0 truncate font-mono text-xs text-muted-foreground sm:block sm:max-w-[14rem]"
                            >
                              {email && (email.to[0] ? bareAddress(email.to[0]) : "-")}
                            </Bone>
                            <Bone
                              id="time"
                              width={64}
                              className="shrink-0 text-xs text-muted-foreground"
                            >
                              {email && <Time iso={email.created_at} />}
                            </Bone>
                          </Link>
                        </li>
                      </BoneScope>
                    ))}
                  </ul>
                </BoneRegion>
              )}
            </section>

            <section className="space-y-3">
              <div className="divide-y overflow-hidden rounded-2xl border">
                <Stat
                  label="Domains"
                  value={
                    overview
                      ? `${overview.counts.verifiedDomains} / ${overview.counts.domains}`
                      : undefined
                  }
                  sub="verified"
                  href="/domains"
                  loading={loading}
                />
                <Stat
                  label="API keys"
                  value={overview?.counts.apiKeys}
                  sub="active"
                  href="/api-keys"
                  loading={loading}
                />
                <Stat
                  label="Webhook endpoints"
                  value={overview?.counts.webhookEndpoints}
                  href="/webhooks"
                  loading={loading}
                />
                <Stat
                  label="Suppressed addresses"
                  value={overview?.counts.suppressions}
                  href="/suppressions"
                  loading={loading}
                />
              </div>

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
        {data && data.overviewError === undefined && (
          <RememberShape def={overviewShape} shape={shape} />
        )}
      </Page>
    </BoneScope>
  )
}
