import type { Metadata } from "next"
import { RememberCount } from "@/components/list/remembered-counts"
import { Globe, Plus } from "lucide-react"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { DomainsList } from "@/components/domains-list"
import { ApiButton } from "@/components/list/api-button"
import { EmptyState } from "@/components/empty-state"
import { IncomingTransfers } from "@/components/incoming-transfers"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { SNIPPETS } from "@/lib/snippets"
import type { ApiKeyRow, DomainSummary, TransferOffer } from "@/lib/types"
import { PAGE_COPY } from "@/lib/page-copy"

export const metadata: Metadata = { title: "Domains" }

/**
 * Every domain this workspace can send from.
 *
 * ⚠ `delegated` IS A COLUMN RATHER THAN A DETAIL, BECAUSE IT CHANGES WHAT THE
 * CUSTOMER IS RESPONSIBLE FOR. A delegated domain's SPF, DKIM, DMARC and MX are
 * ours to keep correct forever; a manually configured one breaks the day
 * somebody tidies up their DNS. Knowing which is which at a glance is the
 * difference between a five-minute debug and an afternoon.
 */
export default async function DomainsPage() {
  /*
   * ⚠ THE KEYS ARE FETCHED FOR THE DELETE DIALOG, AND A FAILURE HERE HIDES THE
   * QUESTION RATHER THAN THE PAGE - the same rule the domain page follows. The
   * domain still deletes; what is lost is the offer to tidy up the keys that
   * only worked for it.
   */
  const [result, keys, incoming] = await Promise.all([
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    tryApi<{ data: ApiKeyRow[] }>("/console/api-keys"),
    // ⚠ A FAILURE HIDES THE OFFERS, NOT THE PAGE. They are still in the email
    // and still here on the next load.
    tryApi<{ data: TransferOffer[] }>("/console/transfers"),
  ])

  const hasRows = result.ok && result.data.data.length > 0

  /*
   * ⚠ ONLY THE LIVE ONES, AND ONLY THE ONES RESTRICTED TO ONE DOMAIN. An
   * unrestricted key works perfectly well for every other domain, so offering
   * to revoke it would be offering to break something unrelated; a revoked key
   * is already dead and naming it would be noise in a dialog that has to be
   * read. Grouped by name once, here, rather than filtered per row.
   */
  const scopedKeys = new Map<string, { id: string; name: string }[]>()
  for (const key of keys.ok ? keys.data.data : []) {
    // ⚠ ONLY KEYS LIMITED TO EXACTLY ONE DOMAIN. Those are the ones deleting
    // that domain leaves able to send from nothing; a key with others keeps them.
    if (key.revoked_at !== null || key.domains.length !== 1) continue
    const only = key.domains[0]!
    const held = scopedKeys.get(only) ?? []
    held.push({ id: key.id, name: key.name })
    scopedKeys.set(only, held)
  }

  return (
    <Page>
      {/*
       * The same header as every page: actions on the title's row, the
       * description under both. (It used to centre its button on title and
       * description together, which put it at a different height from every
       * other page's.)
       */}
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>{PAGE_COPY.domains.title}</PageTitle>
          {/*
           * ⚠ HIDDEN WHILE THE LIST IS EMPTY, BECAUSE THE EMPTY STATE ALREADY
           * CARRIES THIS ACTION. Two buttons for one action, eight inches apart,
           * reads as two different things - and the one in the header is the
           * smaller and less explained of the two, so it wins attention it has
           * not earned. The empty state's version says what will happen; this
           * one just says a noun.
           */}
          <PageActions>
            <ApiButton snippet={SNIPPETS.domains} />
            {hasRows && (
              <ButtonLink href="/domains/new" size="sm">
                <Plus />
                Add domain
              </ButtonLink>
            )}
          </PageActions>
        </PageHeaderRow>
        <PageDescription>{PAGE_COPY.domains.description}</PageDescription>
      </PageHeader>

      <PageBody>
        <IncomingTransfers offers={incoming.ok ? incoming.data.data : []} />

        {!result.ok ? (
          <PanelError
            title="Could not load your domains"
            message={result.error.message}
          />
        ) : !hasRows ? (
          <EmptyState
            icon={<Globe />}
            title="No domains yet"
            description="Add the domain you send from. We will detect who hosts its DNS and tell you exactly what to publish - or do it for you."
            action={{ label: "Add your first domain", href: "/domains/new" }}
          />
        ) : (
          <DomainsList
            domains={result.data.data}
            scopedKeys={Object.fromEntries(scopedKeys)}
          />
        )}
      </PageBody>
      {result.ok && <RememberCount list="domains" count={result.data.data.length} />}
    </Page>
  )
}
