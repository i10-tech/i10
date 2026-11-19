"use client"

import * as React from "react"
import Link from "next/link"
import { Send } from "lucide-react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
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
import { RememberShape, useRecordShape } from "@/components/list/remembered-shapes"
import { Time } from "@/components/time"
import { AttemptLog } from "@/components/webhooks/attempt-log"
import { CodeBlock, HeaderList } from "@/components/webhooks/code-block"
import { DeliveryActions } from "@/components/webhooks/delivery-actions"
import {
  webhookDeliveryDetailShape,
  type WebhookDeliveryDetailData,
  type WebhookDeliveryDetailShape,
} from "@/lib/shapes/webhook-delivery-detail"
import { prettyBody, prettyJson, shortName } from "@/lib/webhooks"

const TONE: Record<WebhookDeliveryDetailShape["status"], HeroTone> = {
  delivered: "success",
  pending: "info",
  failed: "danger",
}

/** What loading.tsx renders: the view with the seeded shape for this delivery. */
export function WebhookDeliveryDetailLoading() {
  return (
    <WebhookDeliveryDetailView shape={useRecordShape(webhookDeliveryDetailShape)} />
  )
}

/**
 * One delivery: what it carried, what was actually sent, and every attempt
 * with its request and response (#286).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (status, transformed, expunged,
 * hasError, polling). Data only fills the bones.
 *
 * ⚠ THE PAYLOAD AND WHAT WAS SENT ARE TWO THINGS when the endpoint has a
 * transformation.
 */
export function WebhookDeliveryDetailView({
  shape,
  data,
}: {
  shape: WebhookDeliveryDetailShape
  data?: WebhookDeliveryDetailData
}) {
  const loading = data === undefined
  const delivery = data?.delivery
  const endpoint = data?.endpoint

  const back =
    delivery && endpoint
      ? `/webhooks/${delivery.endpoint_id}?tab=deliveries`
      : "/webhooks?tab=deliveries"

  return (
    <BoneScope id="webhook-delivery-detail" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <DetailHero
            crumbs={[{ label: "Deliveries", href: back }]}
            icon={<Send />}
            tone={TONE[shape.status]}
            eyebrow="Webhook delivery"
            title={
              <span className="font-mono text-lg sm:text-2xl">
                {delivery?.event_type}
              </span>
            }
            subtitle={<span className="font-mono">{delivery?.id}</span>}
            actions={
              <DeliveryActions
                delivery={delivery}
                status={shape.status}
                expunged={shape.expunged}
                polling={shape.polling}
              />
            }
          />
        </PageHeader>

        <PageBody className="space-y-8">
          <MetaGrid
            items={[
              { label: "Status", value: <DeliveryStatus status={shape.status} /> },
              {
                label: "Last response",
                value: <ResponseCode status={delivery?.response_status ?? null} />,
              },
              {
                label: "Endpoint",
                value: data ? (
                  endpoint ? (
                    <Link
                      href={`/webhooks/${endpoint.id}`}
                      className="font-mono text-xs underline-offset-4 hover:underline"
                      title={shortName(endpoint)}
                    >
                      {shortName(endpoint)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Deleted</span>
                  )
                ) : undefined,
              },
              {
                label: "Occurred",
                value: delivery ? <Time iso={delivery.occurred_at} /> : undefined,
              },
            ]}
          />

          <dl className="grid gap-4 rounded-xl border px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <Fact
              label="Attempts"
              value={
                <Bone id="fact-attempts" width={24} lineHeight={16} inline>
                  {delivery ? String(delivery.attempts) : undefined}
                </Bone>
              }
            />
            <Fact
              label="Sequence"
              value={
                <Bone id="fact-sequence" width={40} lineHeight={16} inline>
                  {delivery
                    ? delivery.sequence === null
                      ? "-"
                      : `#${delivery.sequence}`
                    : undefined}
                </Bone>
              }
            />
            <Fact
              label="Delivered"
              value={
                <Bone id="fact-delivered" width={80} lineHeight={16} inline>
                  {delivery ? (
                    delivery.delivered_at ? (
                      <Time iso={delivery.delivered_at} mode="exact" />
                    ) : (
                      "-"
                    )
                  ) : undefined}
                </Bone>
              }
            />
            <Fact
              label="Next attempt"
              value={
                <Bone id="fact-next-attempt" width={80} lineHeight={16} inline>
                  {delivery ? (
                    delivery.next_attempt_at ? (
                      <Time iso={delivery.next_attempt_at} mode="exact" />
                    ) : (
                      "-"
                    )
                  ) : undefined}
                </Bone>
              }
            />
          </dl>

          {shape.hasError && (
            <div className="rounded-xl border border-danger/25 bg-danger/5 px-4 py-3">
              <p className="text-xs font-medium text-danger">Last error</p>
              <Bone id="last-error" width="100%" lineHeight={16}>
                {delivery?.last_error && (
                  <p className="mt-1 font-mono text-xs break-all">
                    {delivery.last_error}
                  </p>
                )}
              </Bone>
            </div>
          )}

          <Section className="pt-0">
            <SectionTitle>Payload</SectionTitle>
            {shape.expunged && (
              <SectionDescription>
                Expunged{" "}
                {delivery?.payload_expunged_at ? (
                  <Time iso={delivery.payload_expunged_at} mode="exact" />
                ) : (
                  <Bone id="expunged-time" width={80} lineHeight={16} inline />
                )}
                . The attempts below still show what your receiver answered.
              </SectionDescription>
            )}
            <SectionContent>
              {shape.expunged ? (
                <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  This delivery&apos;s data was removed for good.
                </p>
              ) : shape.transformed ? (
                <Tabs defaultValue="sent">
                  <TabsList>
                    <TabsTrigger value="sent">Sent</TabsTrigger>
                    <TabsTrigger value="event">Event</TabsTrigger>
                  </TabsList>
                  <TabsContent value="sent" className="m-0 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      What the endpoint&apos;s transformation made of the event, which
                      is what was sent:{" "}
                      <span className="font-mono text-foreground">
                        {delivery?.transformed ? (
                          `${delivery.transformed.method} ${delivery.transformed.url}`
                        ) : (
                          <Bone
                            id="transformed-url"
                            width={180}
                            lineHeight={16}
                            inline
                          />
                        )}
                      </span>
                    </p>
                    <HeaderList
                      headers={delivery?.transformed?.headers ?? null}
                      empty="No custom headers"
                    />
                    <CodeBlock
                      value={
                        delivery?.transformed
                          ? prettyBody(delivery.transformed.body)
                          : ""
                      }
                      label="sent body"
                      loading={loading}
                    />
                  </TabsContent>
                  <TabsContent value="event" className="m-0">
                    <CodeBlock
                      value={delivery ? prettyJson(delivery.payload) : ""}
                      label="payload"
                      loading={loading}
                    />
                  </TabsContent>
                </Tabs>
              ) : (
                <CodeBlock
                  value={delivery ? prettyJson(delivery.payload) : ""}
                  label="payload"
                  loading={loading}
                />
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
                attempts={delivery?.attempt_log ?? []}
                polling={shape.polling}
                loading={loading}
              />
            </SectionContent>
          </Section>
        </PageBody>

        {delivery && <RememberShape def={webhookDeliveryDetailShape} shape={shape} />}
      </Page>
    </BoneScope>
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
