import type { Metadata } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@repo/ui/components/page"
import { Status } from "@/components/status"
import { Badge } from "@repo/ui/components/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table"
import { DomainActions } from "@/components/domain-actions"
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import type { ApiKeyRow, DomainSummary } from "@/lib/types"

export const metadata: Metadata = { title: "Domains" }

/**
 * Every domain this workspace can send from.
 *
 * ⚠ `delegated` IS A COLUMN RATHER THAN A DETAIL, BECAUSE IT CHANGES WHAT THE
 * CUSTOMER IS RESPONSIBLE FOR. A delegated domain's SPF, DKIM, DMARC and MX are
 * ours to keep correct forever; a manually configured one breaks the day
 * somebody tidies up their DNS. Knowing which is which at a glance is the
 * difference between a five-minute debug and an afternoon.
 *
 * ⚠ THE COLUMNS ARE CENTRED, WHICH IS NOT THIS CONSOLE'S DEFAULT and is a
 * deliberate choice for this table rather than a new house rule. Every column
 * here except the name is a short fixed-width token — a status, a badge, a
 * region, a relative date — and left-aligning those inside 9rem columns left
 * each value stranded at the far edge of a gap, with its heading no nearer.
 * Lists with long or varied values (the logs, the emails) keep their left
 * edge, where a ragged one would be unreadable.
 */
export default async function DomainsPage() {
  /*
   * ⚠ THE KEYS ARE FETCHED FOR THE DELETE DIALOG, AND A FAILURE HERE HIDES THE
   * QUESTION RATHER THAN THE PAGE — the same rule the domain page follows. The
   * domain still deletes; what is lost is the offer to tidy up the keys that
   * only worked for it.
   */
  const [result, keys] = await Promise.all([
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    tryApi<{ data: ApiKeyRow[] }>("/console/api-keys"),
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
    if (key.revoked_at !== null || !key.domain) continue
    const held = scopedKeys.get(key.domain) ?? []
    held.push({ id: key.id, name: key.name })
    scopedKeys.set(key.domain, held)
  }

  return (
    <Page>
      {/*
       * ⚠ THE HEADER IS A ROW HERE, NOT THE USUAL TITLE-ROW-THEN-DESCRIPTION
       * STACK, AND THAT IS THE ONLY WAY THE BUTTON CENTRES. `PageHeader`
       * stacks a `PageHeaderRow` above the description, so an action inside
       * that row lines up with the TITLE and sits visibly high against a
       * two-line description beneath it. Laying the header out as one row puts
       * the button on the centre line of the whole block — title and
       * description together — which is where the eye expects it.
       *
       * ⚠ AND IT IS DONE AT THE CALL SITE RATHER THAN IN `PageHeader`. Every
       * other screen in the console stacks, and changing the primitive would
       * move all of their buttons at once for a preference expressed about
       * this page.
       */}
      <PageHeader className="flex-row items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <PageTitle>Domains</PageTitle>
          <PageDescription>
            Mail leaves from a domain you control. Publish the records we issue, or
            delegate three subdomains to us and never think about them again.
          </PageDescription>
        </div>

        {/*
         * ⚠ HIDDEN WHILE THE LIST IS EMPTY, BECAUSE THE EMPTY STATE ALREADY
         * CARRIES THIS ACTION. Two buttons for one action, eight inches apart,
         * reads as two different things — and the one in the header is the
         * smaller and less explained of the two, so it wins attention it has
         * not earned. The empty state's version says what will happen; this
         * one just says a noun.
         */}
        {hasRows && (
          <PageActions>
            <Button size="sm" asChild>
              <Link href="/domains/new">
                <Plus />
                Add domain
              </Link>
            </Button>
          </PageActions>
        )}
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError
            title="Could not load your domains"
            message={result.error.message}
          />
        ) : !hasRows ? (
          <EmptyState
            title="No domains yet"
            description="Add the domain you send from. We will detect who hosts its DNS and tell you exactly what to publish — or do it for you."
            action={{ label: "Add your first domain", href: "/domains/new" }}
          />
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {/*
                   * ⚠ THE NAME COLUMN STAYS LEFT WHILE THE REST ARE
                   * CENTRED, and the asymmetry is the point rather than an
                   * oversight. A domain name is the row's identity and the
                   * thing somebody's eye runs down the list looking for;
                   * centring it makes every name start at a different x and
                   * turns scanning into reading. The four columns after it are
                   * short fixed tokens, where a shared centre line is tidier
                   * than a left edge stranded in a 9rem gap.
                   *
                   * ⚠ AND THE HEADING CARRIES THE SAME PADDING AS ITS CELLS or
                   * the two stop lining up — the one thing alignment cannot
                   * hide.
                   */}
                  <TableHead className="pl-4">Domain</TableHead>
                  <TableHead className="w-[11rem] text-center">Status</TableHead>
                  <TableHead className="w-[9rem] text-center">Setup</TableHead>
                  <TableHead className="hidden w-[9rem] text-center md:table-cell">
                    Region
                  </TableHead>
                  <TableHead className="w-[10rem] px-5 text-center">Added</TableHead>
                  {/*
                   * ⚠ A HEADING THAT IS READ BUT NOT SEEN. An empty `<th>`
                   * leaves a screen reader announcing the row's last cell with
                   * no column name at all.
                   */}
                  <TableHead className="w-12 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.data.map((domain) => (
                  <TableRow key={domain.id}>
                    <TableCell className="p-0">
                      <Link
                        href={`/domains/${domain.id}`}
                        className="block py-2.5 pr-3 pl-4 font-medium"
                      >
                        {domain.name}
                      </Link>
                    </TableCell>
                    <TableCell className="p-0">
                      <Link
                        href={`/domains/${domain.id}`}
                        className="block px-3 py-2.5 text-center"
                      >
                        <Status status={domain.status} />
                      </Link>
                    </TableCell>
                    <TableCell className="p-0">
                      <Link
                        href={`/domains/${domain.id}`}
                        className="block px-3 py-2.5 text-center"
                      >
                        <Badge variant={domain.delegated ? "secondary" : "outline"}>
                          {domain.delegated ? "Delegated" : "Manual records"}
                        </Badge>
                      </Link>
                    </TableCell>
                    <TableCell className="hidden p-0 md:table-cell">
                      <Link
                        href={`/domains/${domain.id}`}
                        className="block px-3 py-2.5 text-center font-mono text-xs text-muted-foreground"
                      >
                        {domain.region}
                      </Link>
                    </TableCell>
                    <TableCell className="p-0">
                      <Link
                        href={`/domains/${domain.id}`}
                        className="block px-5 py-2.5 text-center text-xs whitespace-nowrap text-muted-foreground"
                        title={domain.created_at}
                      >
                        {formatRelative(domain.created_at)}
                      </Link>
                    </TableCell>
                    {/*
                     * ⚠ THE ONE CELL THAT IS NOT A LINK, and it cannot become
                     * one. Every other cell is a full-bleed link so the whole
                     * row opens the domain; a menu button nested inside one
                     * would navigate on the way to opening itself.
                     */}
                    <TableCell className="py-1.5 pr-4 pl-0 text-right">
                      <DomainActions
                        id={domain.id}
                        name={domain.name}
                        scopedKeys={scopedKeys.get(domain.name) ?? []}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageBody>
    </Page>
  )
}
