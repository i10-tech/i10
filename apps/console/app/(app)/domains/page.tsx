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
  PageHeaderRow,
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
import { EmptyState } from "@/components/empty-state"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import type { DomainSummary } from "@/lib/types"

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
  const result = await tryApi<{ data: DomainSummary[] }>("/console/domains")

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Domains</PageTitle>
          <PageActions>
            <Button size="sm" asChild>
              <Link href="/domains/new">
                <Plus />
                Add domain
              </Link>
            </Button>
          </PageActions>
        </PageHeaderRow>
        <PageDescription>
          Mail leaves from a domain you control. Publish the records we issue, or
          delegate three subdomains to us and never think about them again.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load your domains" message={result.error.message} />
        ) : result.data.data.length === 0 ? (
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
                  <TableHead>Domain</TableHead>
                  <TableHead className="w-[11rem]">Status</TableHead>
                  <TableHead className="w-[9rem]">Setup</TableHead>
                  <TableHead className="hidden w-[9rem] md:table-cell">Region</TableHead>
                  <TableHead className="w-[9rem] text-right">Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.data.map((domain) => (
                  <TableRow key={domain.id}>
                    <TableCell className="p-0">
                      <Link
                        href={`/domains/${domain.id}`}
                        className="block px-3 py-2.5 font-medium"
                      >
                        {domain.name}
                      </Link>
                    </TableCell>
                    <TableCell className="p-0">
                      <Link href={`/domains/${domain.id}`} className="block px-3 py-2.5">
                        <Status status={domain.status} />
                      </Link>
                    </TableCell>
                    <TableCell className="p-0">
                      <Link href={`/domains/${domain.id}`} className="block px-3 py-2.5">
                        <Badge variant={domain.delegated ? "secondary" : "outline"}>
                          {domain.delegated ? "Delegated" : "Manual records"}
                        </Badge>
                      </Link>
                    </TableCell>
                    <TableCell className="hidden p-0 md:table-cell">
                      <Link
                        href={`/domains/${domain.id}`}
                        className="block px-3 py-2.5 font-mono text-xs text-muted-foreground"
                      >
                        {domain.region}
                      </Link>
                    </TableCell>
                    <TableCell className="p-0 text-right">
                      <Link
                        href={`/domains/${domain.id}`}
                        className="block px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground"
                        title={domain.created_at}
                      >
                        {formatRelative(domain.created_at)}
                      </Link>
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
