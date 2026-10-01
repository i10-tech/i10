import type { Metadata } from "next"
import { Tag } from "lucide-react"
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
import { TopicsList } from "@/components/marketing-lists"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import type { TopicRow } from "@/lib/types"

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
  const result = await tryApi<{ data: TopicRow[] }>("/console/topics")
  const hasRows = result.ok && result.data.data.length > 0

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Topics</PageTitle>
          {/*
           * ⚠ HIDDEN WHILE THE LIST IS EMPTY, BECAUSE THE EMPTY STATE ALREADY
           * CARRIES THIS ACTION. Two buttons for one action, eight inches
           * apart, reads as two different things - and the one in the header is
           * the smaller and less explained of the two, so it wins attention it
           * has not earned. The empty state's version says what will happen;
           * this one just says a noun.
           */}
          {hasRows && (
            <PageActions>
              <NewTopicButton />
            </PageActions>
          )}
        </PageHeaderRow>
        <PageDescription>
          The choices a recipient gets on their preference page. Their answer here is
          binding on every broadcast that names the topic.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load topics" message={result.error.message} />
        ) : !hasRows ? (
          <EmptyState
            icon={<Tag />}
            title="No topics yet"
            description="Without topics, unsubscribing is all-or-nothing. A couple of topics lets somebody keep the receipts and drop the newsletter."
            secondary={<NewTopicButton />}
          />
        ) : (
          <TopicsList topics={result.data.data} />
        )}
      </PageBody>
    </Page>
  )
}
