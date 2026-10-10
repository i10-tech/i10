import { Section, SectionContent, SectionTitle } from "@repo/ui/components/page"
import { Stat, StatRow } from "@/components/stat"
import { ListCell, ListHead, ListHeader, ListTable } from "@/components/list/table"
import { StatsCharts } from "@/components/webhooks/stats-chart"
import { WindowPicker } from "@/components/webhooks/window-picker"
import { formatDuration, formatNumber } from "@/lib/format"
import {
  errorRate,
  formatErrorRate,
  rateTone,
  windowFor,
  type WindowValue,
} from "@/lib/webhooks"
import type { WebhookEndpointStats } from "@/lib/types"

/**
 * How the endpoint did over a window (#300): the counts, the error rate, how
 * fast it answered, and which events carried the failures.
 *
 * ⚠ DELIVERIES ARE COUNTED BY WHEN THEY WERE CREATED AND ATTEMPTS BY WHEN THEY
 * WERE MADE, as the API counts them. A delivery from yesterday retried today
 * is yesterday's delivery and today's attempt, so the two charts can disagree
 * about a step, and that is correct.
 */
export function StatsPanel({
  stats,
  window,
}: {
  stats: WebhookEndpointStats
  window: WindowValue
}) {
  const rate = errorRate(stats.attempts, stats.failed_attempts)
  const byType = [...stats.by_event_type].sort(
    (a, b) => b.failed - a.failed || b.delivered - a.delivered,
  )

  return (
    <Section className="space-y-5 pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle className="m-0">Last {windowFor(window).label}</SectionTitle>
        <WindowPicker value={window} />
      </div>

      <StatRow>
        <Stat label="Delivered" value={stats.delivered} />
        <Stat
          label="Failed"
          value={stats.failed}
          tone={stats.failed > 0 ? "danger" : undefined}
        />
        <Stat label="Retrying" value={stats.pending} />
        <Stat
          label="Error rate"
          value={formatErrorRate(rate)}
          tone={rateTone(rate)}
          sub={`${formatNumber(stats.failed_attempts)} of ${formatNumber(stats.attempts)} attempts`}
        />
        <Stat
          label="p50 response"
          value={stats.p50_ms === null ? "-" : formatDuration(Math.round(stats.p50_ms))}
        />
        <Stat
          label="p95 response"
          value={stats.p95_ms === null ? "-" : formatDuration(Math.round(stats.p95_ms))}
        />
      </StatRow>

      <StatsCharts series={stats.series} bucket={stats.bucket} />

      {byType.length > 0 && (
        <SectionContent className="space-y-2">
          <h3 className="text-sm font-medium">By event</h3>
          <ListTable>
            <ListHeader>
              <ListHead>Event</ListHead>
              <ListHead className="w-[7rem] text-right">Delivered</ListHead>
              <ListHead className="w-[7rem] text-right">Failed</ListHead>
              <ListHead className="hidden w-[7rem] text-right sm:table-cell">
                Retrying
              </ListHead>
            </ListHeader>
            <tbody className="divide-y">
              {byType.map((row) => (
                <tr key={row.event_type}>
                  <ListCell className="font-mono text-xs">{row.event_type}</ListCell>
                  <ListCell className="tabular text-right text-xs">
                    {formatNumber(row.delivered)}
                  </ListCell>
                  <ListCell
                    className={
                      row.failed > 0
                        ? "tabular text-right text-xs text-danger"
                        : "tabular text-right text-xs text-muted-foreground"
                    }
                  >
                    {formatNumber(row.failed)}
                  </ListCell>
                  <ListCell className="tabular hidden text-right text-xs text-muted-foreground sm:table-cell">
                    {formatNumber(row.pending)}
                  </ListCell>
                </tr>
              ))}
            </tbody>
          </ListTable>
        </SectionContent>
      )}
    </Section>
  )
}
