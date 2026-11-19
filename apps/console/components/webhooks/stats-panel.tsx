import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Section, SectionContent, SectionTitle } from "@repo/ui/components/i10/page"
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
  events = 0,
  loading = false,
}: {
  stats?: WebhookEndpointStats | null
  window: WindowValue
  /** Rows of the by-event table to draw while loading (the shape's). */
  events?: number
  loading?: boolean
}) {
  const isLoaded = !loading && stats !== null && stats !== undefined
  const rate = isLoaded ? errorRate(stats.attempts, stats.failed_attempts) : null
  const byType = isLoaded
    ? [...stats.by_event_type].sort(
        (a, b) => b.failed - a.failed || b.delivered - a.delivered,
      )
    : []
  const eventRows: (WebhookEndpointStats["by_event_type"][number] | undefined)[] =
    isLoaded ? byType : Array.from({ length: events }, () => undefined)

  return (
    <Section className="space-y-5 pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle className="m-0">Last {windowFor(window).label}</SectionTitle>
        <WindowPicker value={window} />
      </div>

      <StatRow loading={!isLoaded}>
        <Stat label="Delivered" value={isLoaded ? stats.delivered : undefined} />
        <Stat
          label="Failed"
          value={isLoaded ? stats.failed : undefined}
          tone={isLoaded && stats.failed > 0 ? "danger" : undefined}
        />
        <Stat label="Retrying" value={isLoaded ? stats.pending : undefined} />
        <Stat
          label="Error rate"
          value={isLoaded ? formatErrorRate(rate) : undefined}
          tone={isLoaded ? rateTone(rate) : undefined}
          sub={
            isLoaded
              ? `${formatNumber(stats.failed_attempts)} of ${formatNumber(stats.attempts)} attempts`
              : ""
          }
        />
        <Stat
          label="p50 response"
          value={
            isLoaded
              ? stats.p50_ms === null
                ? "-"
                : formatDuration(Math.round(stats.p50_ms))
              : undefined
          }
        />
        <Stat
          label="p95 response"
          value={
            isLoaded
              ? stats.p95_ms === null
                ? "-"
                : formatDuration(Math.round(stats.p95_ms))
              : undefined
          }
        />
      </StatRow>

      <StatsCharts series={stats?.series} bucket={stats?.bucket} loading={!isLoaded} />

      {eventRows.length > 0 && (
        <SectionContent className="space-y-2">
          <h3 className="text-sm font-medium">By event</h3>
          <ListTable>
            <ListHeader>
              <ListHead>Event</ListHead>
              <ListHead className="w-[7rem] text-right">Delivered</ListHead>
              <ListHead className="w-[7rem] text-right">Failed</ListHead>
              {/* F = 224 (Delivered 112, Failed 112), Event keeps 220: Retrying 112 -> 556 -> sm (704). */}
              <ListHead hideBelow="sm" className="w-[7rem] text-right">
                Retrying
              </ListHead>
            </ListHeader>
            <tbody className="divide-y">
              {eventRows.map((row, i) => (
                <BoneScope
                  key={row?.event_type ?? i}
                  id={`event-${i}`}
                  unit
                  loading={!isLoaded}
                >
                  <tr>
                    <ListCell className="font-mono text-xs">
                      <Bone id="event" width={140} lineHeight={16}>
                        {row && (
                          <span className="block truncate" title={row.event_type}>
                            {row.event_type}
                          </span>
                        )}
                      </Bone>
                    </ListCell>
                    <ListCell className="tabular text-right text-xs">
                      <Bone id="delivered" width={32} lineHeight={16} align="end">
                        {row && formatNumber(row.delivered)}
                      </Bone>
                    </ListCell>
                    <ListCell className="tabular text-right text-xs">
                      <Bone id="failed" width={32} lineHeight={16} align="end">
                        {row && (
                          <span
                            className={
                              row.failed > 0 ? "text-danger" : "text-muted-foreground"
                            }
                          >
                            {formatNumber(row.failed)}
                          </span>
                        )}
                      </Bone>
                    </ListCell>
                    <ListCell
                      hideBelow="sm"
                      className="tabular text-right text-xs text-muted-foreground"
                    >
                      <Bone id="retrying" width={32} lineHeight={16} align="end">
                        {row && formatNumber(row.pending)}
                      </Bone>
                    </ListCell>
                  </tr>
                </BoneScope>
              ))}
            </tbody>
          </ListTable>
        </SectionContent>
      )}
    </Section>
  )
}
