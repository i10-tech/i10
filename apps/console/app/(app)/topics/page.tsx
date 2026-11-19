import type { Metadata } from "next"
import { cookies } from "next/headers"
import { TopicsView } from "@/components/topics-view"
import { tryApi } from "@/lib/api"
import { topicsShape, type TopicsData } from "@/lib/shapes/topics"
import type { TopicRow } from "@/lib/types"
import { viewCookie, type View } from "@/lib/views"

export const metadata: Metadata = { title: "Topics" }

/**
 * What a recipient sees on their preference page.
 *
 * ⚠ `default_subscription` IS IMMUTABLE ONCE A TOPIC EXISTS, AND THE UI SAYS SO
 * RATHER THAN DISABLING A CONTROL SILENTLY. Flipping a topic from opt-out to
 * opt-in would retroactively subscribe every contact who simply never answered
 * - marketing mail to people who did not ask for it, at scale, because of a
 * dropdown. The API refuses the field with a 422 for the same reason.
 *
 * ⚠ AND THE SUBSCRIBER COUNT ACCOUNTS FOR THE DEFAULT. On an opt-in topic a
 * contact with no explicit answer IS subscribed, so the count is everybody
 * minus those who said no. Counting only explicit rows would report a new
 * opt-in topic as having zero subscribers while a broadcast to it reaches
 * everyone.
 */
export default async function TopicsPage() {
  const [result, cookieStore] = await Promise.all([
    tryApi<{ data: TopicRow[] }>("/console/topics"),
    cookies(),
  ])
  const view = (cookieStore.get(viewCookie("topics"))?.value as View) ?? "table"

  const data: TopicsData = {
    topics: result.ok ? result.data.data : [],
    view,
    ...(result.ok ? {} : { error: result.error.message }),
  }
  return <TopicsView shape={topicsShape.of(data)} data={data} />
}
