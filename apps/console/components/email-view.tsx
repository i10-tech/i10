"use client"

import * as React from "react"
import Link from "next/link"
import { Mail } from "lucide-react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Alert } from "@repo/ui/components/alert/alert"
import { Page, PageBody, PageHeader } from "@repo/ui/components/i10/page"
import { DetailHero, MetaGrid } from "@/components/detail-hero"
import { Journey } from "@/components/journey"
import { Status } from "@/components/status"
import { Time, useExactTime } from "@/components/time"
import { EmailBodyTabs } from "@/components/email-body-tabs"
import { EventTimeline } from "@/components/event-timeline"
import { RememberShape } from "@/components/list/remembered-shapes"
import { formatBytes } from "@/lib/format"
import { emailJourney } from "@/lib/journey"
import { describeStatus } from "@/lib/status"
import { emailShape, type EmailData, type EmailShape } from "@/lib/shapes/email"
import type { EmailDetail } from "@/lib/types"

type EmailAttachment = NonNullable<EmailDetail["attachments"]>[number]

/**
 * One message, loaded and loading: ONE view so the skeleton matches the record.
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (conditional fields, error alert,
 * attachments section, tags section, timeline step counts); `data` fills the bones.
 */
export function EmailView({ shape, data }: { shape: EmailShape; data?: EmailData }) {
  const exact = useExactTime()
  const loading = data === undefined
  const email = data?.email

  return (
    <BoneScope id="email-detail" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <DetailHero
            crumbs={[{ label: "Emails", href: "/emails" }]}
            icon={<Mail />}
            tone={email ? describeStatus(email.last_event).tone : undefined}
            eyebrow="Email"
            title={
              loading
                ? undefined
                : email?.subject || (
                    <em className="text-muted-foreground">No subject</em>
                  )
            }
            loading={loading}
          />
        </PageHeader>

        <div className="mx-auto w-full max-w-7xl space-y-8 px-6 pt-6">
          <MetaGrid
            items={[
              {
                label: "From",
                value: email ? (
                  <span className="font-mono text-xs">{email.from}</span>
                ) : undefined,
                width: 140,
              },
              {
                label: shape.to > 1 ? `To (${shape.to})` : "To",
                value: email ? (
                  <span className="font-mono text-xs" title={email.to.join(", ")}>
                    {email.to.join(", ")}
                  </span>
                ) : undefined,
                width: 160,
              },
              {
                label: "Status",
                value: email ? (
                  <Status status={email.last_event} variant="pill" />
                ) : undefined,
                shape: "box",
                width: 76,
                height: 20,
              },
              {
                label: "Created",
                value: email ? <Time iso={email.created_at} /> : undefined,
                width: 100,
              },
            ]}
            loading={loading}
          />
          <Journey
            title="Email events"
            steps={loading ? shape.steps : emailJourney(email!)}
          />
        </div>

        <PageBody className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          {/*
           * ⚠ `order` FLIPS AT `lg`, WHICH IS WHY THE TIMELINE IS DECLARED SECOND
           * AND SHOWN FIRST ON SMALL SCREENS. Declaring it first and reordering on
           * desktop would put it first in the DOM, which is also the reading order
           * for a screen reader - and for somebody reading linearly the metadata
           * before the message is the wrong way round.
           */}
          <div className="min-w-0 space-y-6 lg:order-1">
            <EmailBodyTabs
              html={email?.html}
              text={email?.text}
              headers={email?.headers}
              loading={loading}
            />

            {shape.attachments > 0 && (
              <section className="rounded-2xl border">
                <h2 className="border-b px-4 py-2.5 text-sm font-medium">
                  Attachments
                </h2>
                <ul className="divide-y">
                  {(loading
                    ? Array.from(
                        { length: shape.attachments },
                        (): EmailAttachment | undefined => undefined,
                      )
                    : (email?.attachments ?? [])
                  ).map((attachment, index) => (
                    <li
                      key={
                        attachment ? `${attachment.filename ?? "file"}-${index}` : index
                      }
                      className="flex items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <Bone id={`att-name-${index}`} lineHeight={16} width={140}>
                        {attachment && (
                          <span className="min-w-0 truncate font-mono text-xs">
                            {attachment.filename ?? "(unnamed)"}
                          </span>
                        )}
                      </Bone>
                      <Bone id={`att-meta-${index}`} lineHeight={16} width={90}>
                        {attachment && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {attachment.content_type ?? "application/octet-stream"}
                            {attachment.size !== undefined &&
                              ` · ${formatBytes(attachment.size)}`}
                          </span>
                        )}
                      </Bone>
                    </li>
                  ))}
                </ul>
                {/*
                 * ⚠ METADATA ONLY - THE BYTES ARE NOT FETCHED. An attachment is
                 * stored base64-encoded in a jsonb column; a ten-megabyte PDF
                 * would be a thirteen-megabyte JSON response for a page that only
                 * ever renders the filename.
                 */}
              </section>
            )}
          </div>

          <aside className="min-w-0 space-y-6 lg:order-2">
            <section className="rounded-2xl border">
              <h2 className="border-b px-4 py-2.5 text-sm font-medium">Event log</h2>
              <div className="px-4 py-3">
                <EventTimeline
                  events={email?.events}
                  createdAt={email?.created_at}
                  scheduledAt={email?.scheduled_at}
                  stepsCount={shape.log}
                  loading={loading}
                />
              </div>
            </section>

            <section className="rounded-2xl border">
              <h2 className="border-b px-4 py-2.5 text-sm font-medium">Details</h2>
              <dl className="divide-y text-sm">
                <Field label="From" value={email?.from} mono width={140} />
                <Field
                  label="To"
                  value={email ? email.to.join(", ") : undefined}
                  mono
                  width={160}
                />
                {shape.cc > 0 && (
                  <Field
                    label="Cc"
                    value={email ? email.cc.join(", ") : undefined}
                    mono
                    width={140}
                  />
                )}
                {shape.bcc > 0 && (
                  <Field
                    label="Bcc"
                    value={email ? email.bcc.join(", ") : undefined}
                    mono
                    width={140}
                  />
                )}
                {shape.replyTo > 0 && (
                  <Field
                    label="Reply-To"
                    value={email ? email.reply_to.join(", ") : undefined}
                    mono
                    width={140}
                  />
                )}
                <Field label="Message ID" value={email?.id} mono copy width={180} />
                {shape.provider && (
                  <Field
                    label="Provider ID"
                    value={email?.provider_message_id ?? undefined}
                    mono
                    copy
                    width={180}
                  />
                )}
                <Field
                  label="Created"
                  value={email ? exact(email.created_at) : undefined}
                  width={140}
                />
                {shape.scheduled && (
                  <Field
                    label="Scheduled"
                    value={email?.scheduled_at ? exact(email.scheduled_at) : undefined}
                    width={140}
                  />
                )}
                {shape.sent && (
                  <Field
                    label="Sent"
                    value={email?.sent_at ? exact(email.sent_at) : undefined}
                    width={140}
                  />
                )}
                {shape.attempts > 1 && (
                  <Field
                    label="Attempts"
                    value={email ? String(email.attempts) : undefined}
                    width={40}
                  />
                )}
                {shape.broadcast && (
                  <div className="px-4 py-2.5">
                    <dt className="text-xs text-muted-foreground">Broadcast</dt>
                    <dd className="mt-0.5">
                      <Bone id="field-broadcast" lineHeight={20} width={100}>
                        {email && (
                          <Link
                            href={`/broadcasts/${email.broadcast_id}`}
                            className="text-sm underline-offset-4 hover:underline"
                          >
                            View broadcast
                          </Link>
                        )}
                      </Bone>
                    </dd>
                  </div>
                )}
              </dl>
            </section>

            {shape.error && (
              /*
               * ⚠ THE FULL ERROR, UNTRUNCATED, IN MONOSPACE. This is the one
               * place the whole SMTP response belongs - it is what somebody
               * pastes into a support ticket or a search engine, and the log
               * table's one-line summary deliberately cuts it.
               */
              <Alert tone="danger" title="Last error">
                <Bone id="error-body" lines={2} lineHeight={16} width="90%">
                  <span className="block font-mono text-xs break-all whitespace-pre-wrap">
                    {email?.last_error}
                  </span>
                </Bone>
              </Alert>
            )}

            {shape.tags > 0 && (
              <section className="rounded-2xl border">
                <h2 className="border-b px-4 py-2.5 text-sm font-medium">Tags</h2>
                <dl className="divide-y text-sm">
                  {(loading
                    ? Array.from(
                        { length: shape.tags },
                        (): [string, unknown] | undefined => undefined,
                      )
                    : Object.entries(email?.tags ?? {})
                  ).map((tag, index) => (
                    <div key={tag ? tag[0] : index} className="px-4 py-2.5">
                      <dt className="text-xs text-muted-foreground">
                        <Bone id={`tag-label-${index}`} lineHeight={14} width={50}>
                          {tag?.[0]}
                        </Bone>
                      </dt>
                      <dd className="mt-0.5">
                        <Bone id={`tag-val-${index}`} lineHeight={16} width={110}>
                          {tag && (
                            <span className="font-mono text-xs break-all">
                              {String(tag[1])}
                            </span>
                          )}
                        </Bone>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </aside>
        </PageBody>
        {data && <RememberShape def={emailShape} shape={shape} />}
      </Page>
    </BoneScope>
  )
}

function Field({
  label,
  value,
  mono = false,
  copy = false,
  width = 140,
}: {
  label: string
  value?: string
  mono?: boolean
  copy?: boolean
  width?: number | string
}) {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return (
    <div className="px-4 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">
        <Bone id={`field-${id}`} lineHeight={mono ? 16 : 20} width={width}>
          {value !== undefined &&
            (copy && value ? (
              <CopyField value={value} />
            ) : (
              <span
                className={mono ? "font-mono text-xs break-all" : "text-sm"}
                title={value}
              >
                {value}
              </span>
            ))}
        </Bone>
      </dd>
    </div>
  )
}
