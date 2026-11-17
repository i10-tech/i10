import type { Metadata } from "next"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { CreateMailbox } from "@/components/create-mailbox-dialog"
import { EmailSetupGuide } from "@/components/email-setup-card"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { MailboxesList } from "@/components/mailboxes-list"
import { emailSetup } from "@/lib/email-setup"
import { hasHiddenEmailSetup } from "@/lib/email-setup-hidden"
import { addressesByOwner } from "@/lib/mailbox-create"
import type { ConsoleMailbox, StoragePool } from "@/lib/mailbox-view"
import { PAGE_COPY } from "@/lib/page-copy"
import { PREVIEW } from "@/lib/preview"
import { PREVIEW_MEMBERS } from "@/lib/preview-mailboxes"
import type { DomainSummary, Me } from "@/lib/types"

export const metadata: Metadata = { title: "Mailboxes" }

export default async function MailboxesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; scenario?: string }>
}) {
  const params = await searchParams
  // ⚠ `?scenario=` IS PREVIEW ONLY (lib/preview-mailboxes.ts): `PREVIEW` folds to
  // `false` in a production build and the spread, and the query, go with it.
  const scenario = PREVIEW && params.scenario ? { scenario: params.scenario } : {}
  const [me, result, domains, creation] = await Promise.all([
    tryApi<Me>("/console/me", { query: scenario }),
    tryApi<{
      data: ConsoleMailbox[]
      pool: StoragePool
      nextCursor: string | null
    }>("/console/mailboxes", {
      query: { cursor: params.cursor, limit: 50, ...scenario },
    }),
    // ⚠ A FAILURE HIDES THE DOMAINS, NOT THE PAGE: the dialog then says there is
    // none to put a mailbox on, which sends the person to Domains to look.
    tryApi<{ data: DomainSummary[] }>("/console/domains", { query: scenario }),
    // ⚠ A FAILURE READS AS `admins`: a member is then told an admin creates it,
    // never shown a button the API would refuse.
    tryApi<{ mode: "admins" | "members" | "on_join" }>(
      "/console/mailboxes/creation-mode",
    ),
  ])
  const isAdmin = me.ok
    ? (me.data.access?.permissions ?? []).includes("members:manage")
    : false

  /*
   * ⚠ ONLY DOMAINS THAT HOST MAILBOXES AND THAT THIS WORKSPACE HOLDS. Hosting
   * switched on is not enough: a domain another workspace proved since (`owned`
   * false) would be refused at the address, so it is not offered.
   */
  const hosted = domains.ok
    ? domains.data.data
        .filter((d) => d.mailboxes?.enabled && d.mailboxes.owned)
        .map((d) => d.name)
    : []

  const create = {
    domains: hosted,
    // ⚠ THE FIRST PAGE'S OWNERS ONLY. Somebody whose mailbox is on a later page
    // is not greyed out here; picking them is refused by the API in words
    // ("already has a mailbox at ..."), which is the safe direction.
    held: result.ok ? Object.fromEntries(addressesByOwner(result.data.data)) : {},
    clerkEnabled: Boolean(process.env.CLERK_PUBLISHABLE_KEY),
    ...(PREVIEW ? { previewMembers: PREVIEW_MEMBERS } : {}),
  }
  const hasRows = result.ok && result.data.data.length > 0

  /*
   * ⚠ THE GUIDE IS FOR AN ADMIN OF A WORKSPACE WITH NO MAILBOX, ON THE FIRST PAGE.
   * A member never sees it: the steps are an admin's to do, and the empty state
   * already tells them so. It goes for good once a mailbox exists, which is the
   * last step, so there is no "finished" version of it to keep drawing.
   *
   * ⚠ A FAILED LIST READ SHOWS NO GUIDE: "no mailboxes" would be a guess.
   */
  const showGuide = isAdmin && result.ok && !hasRows && !params.cursor
  const tenantId = me.ok ? (me.data.tenant?.id ?? null) : null
  const hidden = showGuide && tenantId ? await hasHiddenEmailSetup(tenantId) : false

  const list = result.ok ? (
    <MailboxesList
      mailboxes={result.data.data}
      pool={result.data.pool}
      nextCursor={result.data.nextCursor}
      isAdmin={isAdmin}
      selfServe={creation.ok && creation.data.mode !== "admins"}
      create={create}
    />
  ) : null

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>{PAGE_COPY.mailboxes.title}</PageTitle>
          {/*
           * Hidden while the list is empty: the empty state carries the action.
           * The loading view keeps a placeholder for it, as the Domains page does.
           */}
          {isAdmin && hasRows && result.ok && (
            <PageActions>
              <CreateMailbox actor="admin" pool={result.data.pool} {...create} />
            </PageActions>
          )}
        </PageHeaderRow>
        <PageDescription>{PAGE_COPY.mailboxes.description}</PageDescription>
      </PageHeader>
      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load mailboxes" message={result.error.message} />
        ) : showGuide && tenantId ? (
          <EmailSetupGuide
            setup={emailSetup(domains.ok ? domains.data.data : null, 0)}
            tenantId={tenantId}
            initiallyHidden={hidden}
            create={create}
            pool={result.data.pool}
            whenHidden={list}
          />
        ) : (
          list
        )}
      </PageBody>
    </Page>
  )
}
