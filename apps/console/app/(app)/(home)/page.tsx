import type { Metadata } from "next"
import { OverviewView } from "@/components/overview-view"
import { readStatus } from "@/components/sending-status-notice"
import { tryApi } from "@/lib/api"
import { overviewShape, type OverviewData } from "@/lib/shapes/overview"
import type { EmailRow, Overview, Page as ApiPage, SendingHealth } from "@/lib/types"
import type { TeamCapacity, JoinSuggestion } from "@/lib/actions"

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

  const [
    overview,
    recent,
    statusResult,
    capacityResult,
    healthResult,
    suggestionsResult,
  ] = await Promise.all([
    tryApi<Overview>("/console/overview", { query: { days } }),
    tryApi<ApiPage<EmailRow>>("/console/emails", { query: { limit: 8 } }),
    readStatus(),
    tryApi<{ data: TeamCapacity | null }>("/console/team/capacity"),
    tryApi<SendingHealth>("/console/sending-health"),
    process.env.CLERK_PUBLISHABLE_KEY
      ? tryApi<{ data: JoinSuggestion[] }>("/console/me/join-suggestions")
      : Promise.resolve({
          ok: false as const,
          error: { message: "disabled", statusCode: 404 },
        }),
  ])

  const hasSuggestions =
    suggestionsResult.ok &&
    Array.isArray(suggestionsResult.data.data) &&
    suggestionsResult.data.data.length > 0

  const data: OverviewData = {
    overview: overview.ok ? overview.data : undefined,
    ...(overview.ok ? {} : { overviewError: overview.error.message }),
    recent: recent.ok ? recent.data.data : undefined,
    ...(recent.ok ? {} : { recentError: recent.error.message }),
    sendingStatus: statusResult.ok ? statusResult.data : null,
    capacity: capacityResult.ok ? capacityResult.data.data : null,
    sendingHealth: healthResult.ok ? healthResult.data : undefined,
    ...(healthResult.ok ? {} : { sendingHealthError: healthResult.error.message }),
    suggestions: hasSuggestions,
    days,
  }

  return <OverviewView shape={overviewShape.of(data)} data={data} />
}
