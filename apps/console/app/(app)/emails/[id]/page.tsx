import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { CopyField } from "@repo/ui/components/copy"
import {
  Page,
  PageActions,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { Status } from "@/components/status"
import { EmailBodyTabs } from "@/components/email-body-tabs"
import { EventTimeline } from "@/components/event-timeline"
import { tryApi } from "@/lib/api"
import { formatBytes, formatExact } from "@/lib/format"
import type { EmailDetail } from "@/lib/types"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<EmailDetail>(`/console/emails/${encodeURIComponent(id)}`)
  // ⚠ THE SUBJECT, NOT THE ID. A browser tab reading `a7f3…` tells somebody
  // nothing about which of the four emails they have open it is.
  return { title: result.ok ? result.data.subject || "Email" : "Email" }
}

/**
 * One message, and everything that happened to it.
 *
 * ⚠ THE EVENT TIMELINE IS THE POINT OF THE PAGE, NOT THE BODY. Somebody opens
 * this because a customer says they did not receive something; the body is
 * confirmation that the right thing was sent, and the timeline is the answer.
 * It is therefore on the right at desktop width and FIRST on mobile — a phone
 * that shows the HTML preview first makes you scroll past a whole email to
 * reach the one line that matters.
 */
export default async function EmailDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const result = await tryApi<EmailDetail>(`/console/emails/${encodeURIComponent(id)}`)

  if (!result.ok) {
    // ⚠ A 404 FROM THE API IS A REAL 404 HERE. RLS makes another tenant's id
    // indistinguishable from a nonexistent one, deliberately — a 403 would
    // confirm the id exists and turn this page into an oracle for enumerating
    // other people's message ids.
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }

  const email = result.data

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon-sm" asChild aria-label="Back to emails">
              <Link href="/emails">
                <ArrowLeft />
              </Link>
            </Button>
            <PageTitle className="truncate">
              {email.subject || <em className="text-muted-foreground">No subject</em>}
            </PageTitle>
          </div>
          <PageActions>
            <Status status={email.last_event} variant="pill" />
          </PageActions>
        </PageHeaderRow>
      </PageHeader>

      <PageBody className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/*
         * ⚠ `order` FLIPS AT `lg`, WHICH IS WHY THE TIMELINE IS DECLARED SECOND
         * AND SHOWN FIRST ON SMALL SCREENS. Declaring it first and reordering on
         * desktop would put it first in the DOM, which is also the reading order
         * for a screen reader — and for somebody reading linearly the metadata
         * before the message is the wrong way round.
         */}
        <div className="min-w-0 space-y-6 lg:order-1">
          <EmailBodyTabs html={email.html} text={email.text} headers={email.headers} />

          {email.attachments && email.attachments.length > 0 && (
            <section className="rounded-lg border">
              <h2 className="border-b px-4 py-2.5 text-sm font-medium">Attachments</h2>
              <ul className="divide-y">
                {email.attachments.map((attachment, index) => (
                  <li
                    key={`${attachment.filename ?? "file"}-${index}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <span className="min-w-0 truncate font-mono text-xs">
                      {attachment.filename ?? "(unnamed)"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {attachment.content_type ?? "application/octet-stream"}
                      {attachment.size !== undefined &&
                        ` · ${formatBytes(attachment.size)}`}
                    </span>
                  </li>
                ))}
              </ul>
              {/*
               * ⚠ METADATA ONLY — THE BYTES ARE NOT FETCHED. An attachment is
               * stored base64-encoded in a jsonb column; a ten-megabyte PDF
               * would be a thirteen-megabyte JSON response for a page that only
               * ever renders the filename.
               */}
            </section>
          )}
        </div>

        <aside className="min-w-0 space-y-6 lg:order-2">
          <section className="rounded-lg border">
            <h2 className="border-b px-4 py-2.5 text-sm font-medium">Timeline</h2>
            <div className="px-4 py-3">
              <EventTimeline
                events={email.events}
                createdAt={email.created_at}
                scheduledAt={email.scheduled_at}
              />
            </div>
          </section>

          <section className="rounded-lg border">
            <h2 className="border-b px-4 py-2.5 text-sm font-medium">Details</h2>
            <dl className="divide-y text-sm">
              <Field label="From" value={email.from} mono />
              <Field label="To" value={email.to.join(", ")} mono />
              {email.cc.length > 0 && (
                <Field label="Cc" value={email.cc.join(", ")} mono />
              )}
              {email.bcc.length > 0 && (
                <Field label="Bcc" value={email.bcc.join(", ")} mono />
              )}
              {email.reply_to.length > 0 && (
                <Field label="Reply-To" value={email.reply_to.join(", ")} mono />
              )}
              <Field label="Message ID" value={email.id} mono copy />
              {email.provider_message_id && (
                <Field
                  label="Provider ID"
                  value={email.provider_message_id}
                  mono
                  copy
                />
              )}
              <Field label="Created" value={formatExact(email.created_at)} />
              {email.scheduled_at && (
                <Field label="Scheduled" value={formatExact(email.scheduled_at)} />
              )}
              {email.sent_at && (
                <Field label="Sent" value={formatExact(email.sent_at)} />
              )}
              {email.route && (
                <Field
                  label="Route"
                  value={email.route === "ses" ? "Amazon SES" : "Direct"}
                />
              )}
              {email.attempts > 1 && (
                <Field label="Attempts" value={String(email.attempts)} />
              )}
              {email.broadcast_id && (
                <div className="px-4 py-2.5">
                  <dt className="text-xs text-muted-foreground">Broadcast</dt>
                  <dd className="mt-0.5">
                    <Link
                      href={`/broadcasts/${email.broadcast_id}`}
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      View broadcast
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
          </section>

          {email.last_error && (
            /*
             * ⚠ THE FULL ERROR, UNTRUNCATED, IN MONOSPACE. This is the one
             * place the whole SMTP response belongs — it is what somebody
             * pastes into a support ticket or a search engine, and the log
             * table's one-line summary deliberately cuts it.
             */
            <section className="rounded-lg border border-danger/25 bg-danger/5">
              <h2 className="border-b border-danger/25 px-4 py-2.5 text-sm font-medium text-danger">
                Last error
              </h2>
              <pre className="overflow-x-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap">
                {email.last_error}
              </pre>
            </section>
          )}

          {email.tags && Object.keys(email.tags).length > 0 && (
            <section className="rounded-lg border">
              <h2 className="border-b px-4 py-2.5 text-sm font-medium">Tags</h2>
              <dl className="divide-y text-sm">
                {Object.entries(email.tags).map(([key, value]) => (
                  <Field key={key} label={key} value={String(value)} mono />
                ))}
              </dl>
            </section>
          )}
        </aside>
      </PageBody>
    </Page>
  )
}

function Field({
  label,
  value,
  mono = false,
  copy = false,
}: {
  label: string
  value: string
  mono?: boolean
  copy?: boolean
}) {
  return (
    <div className="px-4 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">
        {copy ? (
          <CopyField value={value} />
        ) : (
          <span
            className={mono ? "font-mono text-xs break-all" : "text-sm"}
            title={value}
          >
            {value}
          </span>
        )}
      </dd>
    </div>
  )
}
