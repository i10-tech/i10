import type { Metadata } from "next"
import { Badge } from "@repo/ui/components/badge"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { NewTopicButton } from "@/components/new-topic"
import { TopicActions } from "@/components/topic-actions"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatNumber } from "@/lib/format"
import type { TopicRow } from "@/lib/types"

export const metadata: Metadata = { title: "Topics" }

/**
 * What a recipient sees on their preference page.
 *
 * ⚠ `default_subscription` IS IMMUTABLE ONCE A TOPIC EXISTS, AND THE UI SAYS SO
 * RATHER THAN DISABLING A CONTROL SILENTLY. Flipping a topic from opt-out to
 * opt-in would retroactively subscribe every contact who simply never answered
 * — marketing mail to people who did not ask for it, at scale, because of a
 * dropdown. The API refuses the field with a 422 for the same reason.
 *
 * ⚠ AND THE SUBSCRIBER COUNT ACCOUNTS FOR THE DEFAULT. On an opt-in topic a
 * contact with no explicit answer IS subscribed, so the count is everybody
 * minus those who said no. Counting only explicit rows would report a new
 * opt-in topic as having zero subscribers while a broadcast to it reaches
 * everyone.
 */
export default async function TopicsPage() {
  const result = await tryApi<{ data: TopicRow[] }>("/console/topics")

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Topics</PageTitle>
          <PageActions>
            <NewTopicButton />
          </PageActions>
        </PageHeaderRow>
        <PageDescription>
          The choices a recipient gets on their preference page. Their answer here
          is binding on every broadcast that names the topic.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load topics" message={result.error.message} />
        ) : result.data.data.length === 0 ? (
          <EmptyState
            title="No topics yet"
            description="Without topics, unsubscribing is all-or-nothing. A couple of topics lets somebody keep the receipts and drop the newsletter."
          />
        ) : (
          <ul className="space-y-3">
            {result.data.data.map((topic) => (
              <li
                key={topic.id}
                className="flex items-start justify-between gap-3 rounded-lg border px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{topic.name}</span>
                    <Badge variant="outline">
                      {topic.default_subscription === "opt_in"
                        ? "Opt-out by default"
                        : "Opt-in required"}
                    </Badge>
                    <Badge variant={topic.visibility === "public" ? "secondary" : "outline"}>
                      {topic.visibility}
                    </Badge>
                  </div>
                  {topic.description && (
                    <p className="text-xs text-muted-foreground">{topic.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    <span className="tabular text-foreground">
                      {formatNumber(topic.subscriber_count)}
                    </span>{" "}
                    {topic.subscriber_count === 1 ? "subscriber" : "subscribers"}
                  </p>
                </div>
                <TopicActions topic={topic} />
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </Page>
  )
}
