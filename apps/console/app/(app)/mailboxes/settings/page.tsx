import type { Metadata } from "next"
import Link from "next/link"
import { UsageMeter } from "@repo/ui/components/usage-meter/usage-meter"
import {
  Page,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { MailboxCreationMode } from "@/components/mailbox-creation-mode"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import {
  storageSummary,
  unallocatedLine,
  type CreationMode,
} from "@/lib/mailbox-settings"
import { meterScale, type StoragePool } from "@/lib/mailbox-view"
import { PAGE_COPY } from "@/lib/page-copy"
import { PREVIEW } from "@/lib/preview"
import type { DomainSummary, Me } from "@/lib/types"

export const metadata: Metadata = { title: PAGE_COPY.mailboxSettings.title }

const LINK =
  "font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"

/**
 * The settings that belong to mailboxes rather than the workspace: who creates
 * them, and how storage is shared between them.
 *
 * ⚠ A MEMBER SEES THE FIRST AND NOT THE SECOND. Who creates mailboxes is
 * something anybody can learn by trying (the API lets any member read it), but
 * the storage pool is the workspace's plan and is an admin's to see and divide.
 *
 * ⚠ A FAILED READ OF THE MODE SAYS SO, NOT "ONLY ADMINS". Showing the strictest
 * choice as if it were the current one would let an admin's next click look like
 * a change from it.
 *
 * ⚠ THE STORAGE HERE IS AN OVERVIEW, NOT A SECOND PLACE TO CHANGE IT. A mailbox's
 * share is set on the mailbox (Change storage, on its page and in the list's row
 * menu), where the person it belongs to is in front of you.
 */
export default async function MailboxSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>
}) {
  const params = await searchParams
  // ⚠ PREVIEW ONLY, as on the Mailboxes page.
  const scenario = PREVIEW && params.scenario ? { scenario: params.scenario } : {}
  const [me, creation, mailboxes, domains] = await Promise.all([
    tryApi<Me>("/console/me", { query: scenario }),
    tryApi<{ mode: CreationMode }>("/console/mailboxes/creation-mode"),
    tryApi<{ pool: StoragePool }>("/console/mailboxes", {
      query: { limit: 1, ...scenario },
    }),
    tryApi<{ data: DomainSummary[] }>("/console/domains", { query: scenario }),
  ])
  const isAdmin = me.ok
    ? (me.data.access?.permissions ?? []).includes("members:manage")
    : false
  const hostedDomains = domains.ok
    ? domains.data.data.filter((d) => d.mailboxes?.enabled && d.mailboxes.owned).length
    : 0

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>{PAGE_COPY.mailboxSettings.title}</PageTitle>
        </PageHeaderRow>
        <PageDescription>{PAGE_COPY.mailboxSettings.description}</PageDescription>
      </PageHeader>
      <PageBody>
        <div className="min-w-0 max-w-3xl">
          <Section className="pt-0">
            <SectionTitle>Who creates mailboxes</SectionTitle>
            <SectionDescription>
              {isAdmin
                ? "Choose how people in this workspace get a mailbox."
                : "How people in this workspace get a mailbox."}
            </SectionDescription>
            <SectionContent>
              {creation.ok ? (
                <MailboxCreationMode
                  mode={creation.data.mode}
                  canChange={isAdmin}
                  hostedDomains={hostedDomains}
                />
              ) : (
                <PanelError
                  title="Could not load this setting"
                  message={creation.error.message}
                />
              )}
            </SectionContent>
          </Section>

          {isAdmin && (
            <Section>
              <SectionTitle>Storage</SectionTitle>
              <SectionDescription>
                How much room mailboxes have, and how much is left to give out.
              </SectionDescription>
              <SectionContent>
                {mailboxes.ok ? (
                  <StorageOverview pool={mailboxes.data.pool} />
                ) : (
                  <PanelError
                    title="Could not load storage"
                    message={mailboxes.error.message}
                  />
                )}
              </SectionContent>
            </Section>
          )}
        </div>
      </PageBody>
    </Page>
  )
}

function StorageOverview({ pool }: { pool: StoragePool }) {
  const summary = storageSummary(pool)
  const unallocated = unallocatedLine(pool)
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card p-6">
        <h3 className="text-sm font-medium">{summary.title}</h3>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{summary.body}</p>
        {pool.kind === "pool" && pool.total != null && (
          <div className="mt-4">
            {/* ⚠ SCALED TO GB, NOT BYTES: a ten digit number is not an answer. */}
            <UsageMeter
              label="Given to mailboxes"
              limit={pool.total / meterScale(pool.total).divisor}
              decimals={1}
              unit={meterScale(pool.total).unit}
              segments={[
                {
                  id: "allocated",
                  label: "Given",
                  value: pool.allocated / meterScale(pool.total).divisor,
                },
              ]}
            />
          </div>
        )}
        {unallocated && (
          <p className="mt-3 text-xs text-muted-foreground">{unallocated}</p>
        )}
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        To change how much one mailbox gets, open it from{" "}
        <Link href="/mailboxes" className={LINK}>
          Mailboxes
        </Link>{" "}
        and choose Change storage.
        {pool.kind === "pool" && (
          <>
            {" "}
            Need more room overall? Change your plan in{" "}
            <Link href="/settings/billing" className={LINK}>
              Billing
            </Link>
            .
          </>
        )}
      </p>
    </div>
  )
}
