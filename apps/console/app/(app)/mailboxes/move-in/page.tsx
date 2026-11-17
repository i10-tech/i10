import type { Metadata } from "next"
import Link from "next/link"
import { Inbox } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  Page,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { TRANSFER_SECTION_ID } from "@/components/mailbox-transfer"
import { tryApi } from "@/lib/api"
import { formatBytes } from "@/lib/format"
import {
  IMPORT_FORMATS,
  IMPORT_SOURCES,
  MAX_ARCHIVE_BYTES,
  MAX_MESSAGE_MB,
} from "@/lib/mailbox-transfer"
import { statusInfo, type ConsoleMailbox, type StoragePool } from "@/lib/mailbox-view"
import { PAGE_COPY } from "@/lib/page-copy"
import { PREVIEW } from "@/lib/preview"
import type { Me } from "@/lib/types"

export const metadata: Metadata = { title: PAGE_COPY.mailboxMoveIn.title }

/** The most mailboxes listed: past this the Mailboxes page is the place to look. */
const LIST_LIMIT = 200

/**
 * Where somebody starts when they want their old mail in a mailbox here.
 *
 * ⚠ A GUIDE AND A LIST OF DOORS, NOT A SECOND IMPORT. The upload, its progress and
 * its refusals all live in the mailbox page's Export and import section
 * (components/mailbox-transfer.tsx, anchor `#transfer`); copying any of it here
 * would be two screens that disagree about what a file may be. This page only
 * says what to do and links each mailbox to that section.
 *
 * ⚠ THE FILE WORDS ARE LIB/MAILBOX-TRANSFER'S, imported, so the page and the
 * import dialog cannot name different formats or limits.
 *
 * ⚠ A MEMBER GETS THEIR OWN MAILBOX ONLY, because that is all the API lists them
 * (`/console/mailboxes`); nothing is filtered here. The API stays the check on
 * every import.
 */
export default async function MoveMailInPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>
}) {
  const params = await searchParams
  // ⚠ PREVIEW ONLY, as on the Mailboxes page.
  const scenario = PREVIEW && params.scenario ? { scenario: params.scenario } : {}
  const [me, result] = await Promise.all([
    tryApi<Me>("/console/me", { query: scenario }),
    tryApi<{
      data: ConsoleMailbox[]
      pool: StoragePool
      nextCursor: string | null
    }>("/console/mailboxes", { query: { limit: LIST_LIMIT, ...scenario } }),
  ])
  const isAdmin = me.ok
    ? (me.data.access?.permissions ?? []).includes("members:manage")
    : false

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>{PAGE_COPY.mailboxMoveIn.title}</PageTitle>
        </PageHeaderRow>
        <PageDescription>{PAGE_COPY.mailboxMoveIn.description}</PageDescription>
      </PageHeader>
      <PageBody className="space-y-8">
        <section aria-labelledby="move-in-steps" className="max-w-2xl space-y-4">
          <h2 id="move-in-steps" className="text-lg font-medium">
            How it works
          </h2>
          <ol className="list-decimal space-y-3 pl-5 text-sm marker:text-muted-foreground">
            <li className="pl-1">
              <span className="font-medium">
                Export your mail from the old provider.
              </span>{" "}
              <span className="text-muted-foreground">
                Every mail app has a way to save its mail as a file. Below is how to do
                it in the most common ones.
              </span>
            </li>
            <li className="pl-1">
              <span className="font-medium">Pick the mailbox it should go into.</span>{" "}
              <span className="text-muted-foreground">
                Choose it in the list below. It opens the mailbox at its Export and
                import section.
              </span>
            </li>
            <li className="pl-1">
              <span className="font-medium">Choose the file and start the import.</span>{" "}
              <span className="text-muted-foreground">
                Keep the page open until the upload finishes. After that it carries on
                without you, and a big mailbox can take a while. Its progress shows on
                the mailbox page.
              </span>
            </li>
          </ol>
          <p className="text-sm text-muted-foreground">
            This only copies old mail in. New mail keeps arriving wherever your
            domain&apos;s records send it today, which you change in the setup steps on
            the Mailboxes page.
          </p>
        </section>

        <section aria-labelledby="move-in-files" className="max-w-2xl space-y-4">
          <h2 id="move-in-files" className="text-lg font-medium">
            Which files work
          </h2>
          <p className="text-sm text-muted-foreground">
            A {IMPORT_FORMATS} file. We read the contents, not the name, so a file with
            no extension is fine. Up to {formatBytes(MAX_ARCHIVE_BYTES)} in one file,
            and each message up to {MAX_MESSAGE_MB} MB.
          </p>
          <dl className="divide-y rounded-2xl border bg-card text-sm">
            {IMPORT_SOURCES.map((source) => (
              <div
                key={source.app}
                className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_1fr] sm:gap-4"
              >
                <dt className="font-medium">{source.app}</dt>
                <dd className="text-muted-foreground">{source.how}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="move-in-mailboxes" className="max-w-2xl space-y-4">
          <h2 id="move-in-mailboxes" className="text-lg font-medium">
            {isAdmin ? "Choose a mailbox" : "Your mailbox"}
          </h2>
          {!result.ok ? (
            <PanelError
              title="Could not load mailboxes"
              message={result.error.message}
            />
          ) : result.data.data.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title="No mailbox to move mail into"
              description={
                isAdmin
                  ? "Create a mailbox first. The setup steps on the Mailboxes page take you through it."
                  : "You do not have a mailbox yet. An owner or admin sets mail up for the team."
              }
              {...(isAdmin
                ? { action: { label: "Go to mailboxes", href: "/mailboxes" } }
                : {})}
            />
          ) : (
            <>
              <ul className="divide-y rounded-2xl border bg-card">
                {result.data.data.map((mailbox) => (
                  <MailboxChoice key={mailbox.address} mailbox={mailbox} />
                ))}
              </ul>
              {result.data.nextCursor && (
                <p className="text-sm text-muted-foreground">
                  Showing the first {LIST_LIMIT}. For the rest, open a mailbox from{" "}
                  <Link
                    href="/mailboxes"
                    className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                  >
                    Mailboxes
                  </Link>
                  .
                </p>
              )}
            </>
          )}
        </section>
      </PageBody>
    </Page>
  )
}

function MailboxChoice({ mailbox }: { mailbox: ConsoleMailbox }) {
  const status = statusInfo(mailbox.status)
  const name = mailbox.owner.name ?? mailbox.displayName ?? mailbox.address
  const href = `/mailboxes/${encodeURIComponent(mailbox.address)}`
  // ⚠ A MAILBOX BEING DELETED TAKES NO MORE MAIL, and its page says so; sending
  // somebody to an import button that is not there would be a dead end.
  const deleting = mailbox.status === "deleting"
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{mailbox.address}</p>
      </div>
      <div className="flex items-center gap-3">
        <Badge tone={status.tone}>{status.label}</Badge>
        <ButtonLink
          href={deleting ? href : `${href}#${TRANSFER_SECTION_ID}`}
          variant="secondary"
          size="sm"
          aria-label={
            deleting ? `Open ${mailbox.address}` : `Move mail into ${mailbox.address}`
          }
        >
          {deleting ? "Open" : "Move mail in"}
        </ButtonLink>
      </div>
    </li>
  )
}
