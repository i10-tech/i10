import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Send } from "lucide-react"
import {
  Page,
  PageBody,
  PageHeader,
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs/tabs"
import { DetailHero, MetaGrid, type HeroTone } from "@/components/detail-hero"
import { DeliveryStatus, ResponseCode } from "@/components/deliveries-table"
import { Time } from "@/components/time"
import { AttemptLog } from "@/components/webhooks/attempt-log"
import { CodeBlock, HeaderList } from "@/components/webhooks/code-block"
import { DeliveryActions } from "@/components/webhooks/delivery-actions"
import { tryApi } from "@/lib/api"
import { prettyBody, prettyJson, shortName } from "@/lib/webhooks"
import type { WebhookDeliveryDetail, WebhookEndpoint } from "@/lib/types"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<WebhookDeliveryDetail>(
    `/console/webhook-deliveries/${encodeURIComponent(id)}`,
  )
  return { title: result.ok ? result.data.event_type : "Delivery" }
}

const TONE: Record<WebhookDeliveryDetail["status"], HeroTone> = {
  delivered: "success",
  pending: "info",
  failed: "danger",
}

/**
 * One delivery: what it carried, what was actually sent, and every attempt
 * with its request and response (#286).
 *
 * ⚠ THE PAYLOAD AND WHAT WAS SENT ARE TWO THINGS when the endpoint has a
 * transformation. The payload is the event; "Sent" is what the transformation
 * made of it, fixed at the first attempt so every retry sends the same bytes.
 * Showing only one of them hides either the bug in the event or the bug in
 * the function.
 */
export default async function DeliveryPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const result = await tryApi<WebhookDeliveryDetail>(
    `/console/webhook-deliveries/${encodeURIComponent(id)}`,
  )
  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }
  const delivery = result.data

  // ⚠ THE ENDPOINT MAY HAVE BEEN DELETED; its deliveries outlive it, and the
  // page still renders, with the way back going to the list instead.
  const endpoint = await tryApi<WebhookEndpoint>(
    `/console/webhook-endpoints/${encodeURIComponent(delivery.endpoint_id)}`,
  )
  const back = endpoint.ok
    ? `/webhooks/${delivery.endpoint_id}?tab=deliveries`
    : "/webhooks?tab=deliveries"

  const expunged = delivery.payload_expunged_at !== null

  return (
    <Page>
      <PageHeader>
        <DetailHero
          crumbs={[{ label: "Deliveries", href: back }]}
          icon={<Send />}
          tone={TONE[delivery.status]}
          eyebrow="Webhook delivery"
          title={
            <span className="font-mono text-lg sm:text-2xl">{delivery.event_type}</span>
          }
          subtitle={<span className="font-mono">{delivery.id}</span>}
          actions={
            <DeliveryActions
              delivery={delivery}
              polling={endpoint.ok && endpoint.data.kind === "polling"}
            />
          }
        />
      </PageHeader>

      <PageBody className="space-y-8">
        <MetaGrid
          items={[
            { label: "Status", value: <DeliveryStatus status={delivery.status} /> },
            {
              label: "Last response",
              value: <ResponseCode status={delivery.response_status} />,
            },
            {
              label: "Endpoint",
              value: endpoint.ok ? (
                <Link
                  href={`/webhooks/${endpoint.data.id}`}
                  className="font-mono text-xs underline-offset-4 hover:underline"
                  title={shortName(endpoint.data)}
                >
                  {shortName(endpoint.data)}
                </Link>
              ) : (
                <span className="text-muted-foreground">Deleted</span>
              ),
            },
            { label: "Occurred", value: <Time iso={delivery.occurred_at} /> },
          ]}
        />

        <dl className="grid gap-4 rounded-xl border px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Attempts" value={String(delivery.attempts)} />
          <Fact
            label="Sequence"
            value={delivery.sequence === null ? "-" : `#${delivery.sequence}`}
          />
          <Fact
            label="Delivered"
            value={
              delivery.delivered_at ? (
                <Time iso={delivery.delivered_at} mode="exact" />
              ) : (
                "-"
              )
            }
          />
          <Fact
            label="Next attempt"
            value={
              delivery.next_attempt_at ? (
                <Time iso={delivery.next_attempt_at} mode="exact" />
              ) : (
                "-"
              )
            }
          />
        </dl>

        {delivery.last_error && delivery.status !== "delivered" && (
          <div className="rounded-xl border border-danger/25 bg-danger/5 px-4 py-3">
            <p className="text-xs font-medium text-danger">Last error</p>
            <p className="mt-1 font-mono text-xs break-all">{delivery.last_error}</p>
          </div>
        )}

        <Section className="pt-0">
          <SectionTitle>Payload</SectionTitle>
          {expunged && (
            <SectionDescription>
              Expunged <Time iso={delivery.payload_expunged_at!} mode="exact" />. The
              attempts below still show what your receiver answered.
            </SectionDescription>
          )}
          <SectionContent>
            {expunged ? (
              <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                This delivery&apos;s data was removed for good.
              </p>
            ) : delivery.transformed ? (
              <Tabs defaultValue="sent">
                <TabsList>
                  <TabsTrigger value="sent">Sent</TabsTrigger>
                  <TabsTrigger value="event">Event</TabsTrigger>
                </TabsList>
                <TabsContent value="sent" className="m-0 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    What the endpoint&apos;s transformation made of the event, which is
                    what was sent:{" "}
                    <span className="font-mono text-foreground">
                      {delivery.transformed.method} {delivery.transformed.url}
                    </span>
                  </p>
                  <HeaderList
                    headers={delivery.transformed.headers}
                    empty="No custom headers"
                  />
                  <CodeBlock
                    value={prettyBody(delivery.transformed.body)}
                    label="sent body"
                  />
                </TabsContent>
                <TabsContent value="event" className="m-0">
                  <CodeBlock value={prettyJson(delivery.payload)} label="payload" />
                </TabsContent>
              </Tabs>
            ) : (
              <CodeBlock value={prettyJson(delivery.payload)} label="payload" />
            )}
          </SectionContent>
        </Section>

        <Section>
          <SectionTitle>Attempts</SectionTitle>
          <SectionDescription>
            Newest first. Each shows the headers we sent and what came back.
          </SectionDescription>
          <SectionContent>
            <AttemptLog
              attempts={delivery.attempt_log}
              polling={endpoint.ok && endpoint.data.kind === "polling"}
            />
          </SectionContent>
        </Section>
      </PageBody>
    </Page>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 font-mono">{value}</dd>
    </div>
  )
}
