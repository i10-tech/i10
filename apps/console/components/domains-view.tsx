"use client"

import * as React from "react"
import Link from "next/link"
import { Copy, Globe, Plus, RefreshCw, SearchX, Trash2 } from "lucide-react"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { cn } from "cn"
import { DomainActions } from "@/components/domain-actions"
import { DeleteDomainsDialog } from "@/components/delete-domain-dialog"
import { EmptyState } from "@/components/empty-state"
import { IncomingTransfers } from "@/components/incoming-transfers"
import { ApiButton } from "@/components/list/api-button"
import { BulkBar } from "@/components/list/bulk-bar"
import { MotionBody, MotionRow } from "@/components/list/motion"
import {
  RememberShape,
  seedShape,
  useRememberedShape,
} from "@/components/list/remembered-shapes"
import { useListSelection } from "@/components/list/selection"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListTable,
  ListTile,
  selectedRowClass,
} from "@/components/list/table"
import {
  FilterSelect,
  ListResults,
  ListSearch,
  ListToolbar,
  ListToolbarEnd,
} from "@/components/list/toolbar"
import { PanelError } from "@/components/panel-error"
import { Status, StatusDot, describeStatus } from "@/components/status"
import { verifyDomain } from "@/lib/actions"
import { PAGE_COPY } from "@/lib/page-copy"
import { NONE } from "@/lib/react"
import {
  domainsShape,
  statusOf,
  type DomainsData,
  type DomainsShape,
} from "@/lib/shapes/domains"
import { domainDetailShape, seedDomainShape } from "@/lib/shapes/domain-detail"
import { SNIPPETS } from "@/lib/snippets"
import { toastDone, toastError } from "@/lib/toast"
import type { DomainSummary } from "@/lib/types"
import { Time } from "@/components/time"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function DomainsLoading() {
  return <DomainsView shape={useRememberedShape(domainsShape)} />
}

const NAME_WIDTHS = ["62%", "48%", "72%", "55%"]

/**
 * The domains page, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (header action, banner, empty state
 * or table, the filters); `data` only fills the bones. The same file draws both.
 *
 * ⚠ A TABLE ONLY (2026-10-03). A workspace's domains are a list you compare,
 * not a gallery you browse.
 *
 * ⚠ FILTERED IN THE BROWSER. A workspace has a handful of domains and the API
 * returns all of them.
 *
 * ⚠ THE STATUS FILTER OFFERS EVERY STATUS A DOMAIN CAN HAVE, not the ones
 * present: the list is the same while the page loads and after, so the select
 * never changes width when the data lands. The regions are the data's own, so
 * their select is a fixed width.
 */
const STATUSES = [
  "not_started",
  "pending",
  "verified",
  "temporary_failure",
  "failed",
  "displaced",
]

export function DomainsView({
  shape,
  data,
}: {
  shape: DomainsShape
  data?: DomainsData
}) {
  const loading = data === undefined
  const domains = data?.domains ?? NONE
  const scopedKeys = data?.scopedKeys ?? {}

  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("")
  const [region, setRegion] = React.useState("")

  const regions = [...new Set(domains.map((d) => d.region))].sort()

  const q = query.trim().toLowerCase()
  const shown = domains.filter(
    (d) =>
      (!q || d.name.toLowerCase().includes(q)) &&
      (!status || statusOf(d) === status) &&
      (!region || d.region === region),
  )
  const filtered = status !== "" || region !== ""
  const clear = () => {
    setQuery("")
    setStatus("")
    setRegion("")
  }

  const selection = useListSelection(shown, (d) => d.id)
  const { picked, clear: clearSelection } = selection

  const [deleting, setDeleting] = React.useState(false)
  // Held while the dialog closes, so its title does not change under the tick.
  const [deletingDomains, setDeletingDomains] = React.useState<DomainSummary[]>([])
  const [checking, setChecking] = React.useState(false)

  async function recheck() {
    if (checking) return
    setChecking(true)
    let verified = 0
    let failed = 0
    for (const d of picked) {
      const result = await verifyDomain(d.id)
      if (!result.ok) failed += 1
      else if (result.data.status === "verified") verified += 1
    }
    setChecking(false)
    const waiting = picked.length - verified - failed
    const summary = [
      verified > 0 && `${verified} verified`,
      waiting > 0 && `${waiting} still waiting on DNS`,
      failed > 0 && `${failed} could not be checked`,
    ]
      .filter(Boolean)
      .join(", ")
    if (failed === picked.length) toastError("Could not check the records", summary)
    else
      toastDone(
        `Checked ${picked.length} ${picked.length === 1 ? "domain" : "domains"}`,
        summary,
      )
  }

  const label = (d: DomainSummary) =>
    // ⚠ "FAILED" IS THE WRONG WORD FOR A DISPLACED DOMAIN. Nothing about its DNS
    // failed; another workspace proved it.
    d.displaced_at ? "Verified elsewhere" : undefined

  // Rows to draw: the data's, or as many placeholders as the shape remembers.
  const rows: (DomainSummary | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : shown
  const hasRows = shape.rows > 0
  const Body = loading ? ListBody : MotionBody
  const RowEl = loading ? ListRow : MotionRow

  return (
    <BoneScope id="domains" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.domains.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.domains.title}</PageTitle>
            )}
            {/*
             * ⚠ HIDDEN WHILE THE LIST IS EMPTY, BECAUSE THE EMPTY STATE ALREADY
             * CARRIES THIS ACTION. Two buttons for one action, eight inches
             * apart, reads as two different things.
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
          <IncomingTransfers count={shape.transfers} offers={data?.offers} />

          {data?.error !== undefined ? (
            <PanelError title="Could not load your domains" message={data.error} />
          ) : !hasRows ? (
            <EmptyState
              icon={<Globe />}
              title="No domains yet"
              description="Add the domain you send from. We will detect who hosts its DNS and tell you exactly what to publish - or do it for you."
              action={{ label: "Add your first domain", href: "/domains/new" }}
            />
          ) : (
            <div>
              <ListToolbar>
                <ListSearch
                  value={query}
                  onChange={setQuery}
                  placeholder="Search domains"
                  label="Search domains"
                />
                <ListResults
                  count={shown.length}
                  query={query}
                  filtered={filtered}
                  noun={["domain", "domains"]}
                  onClear={clear}
                />
                <ListToolbarEnd>
                  {shape.statusFilter && (
                    <FilterSelect
                      value={status}
                      onValueChange={setStatus}
                      label="Status"
                      allLabel="All statuses"
                      options={STATUSES.map((s) => {
                        const described = describeStatus(
                          s === "displaced" ? "failed" : s,
                        )
                        return {
                          value: s,
                          label:
                            s === "displaced" ? "Verified elsewhere" : described.label,
                          icon: <StatusDot tone={described.tone} />,
                        }
                      })}
                    />
                  )}
                  {shape.regionFilter && (
                    <FilterSelect
                      value={region}
                      onValueChange={setRegion}
                      label="Region"
                      allLabel="All regions"
                      triggerWidth={176}
                      options={regions.map((r) => ({ value: r, label: r }))}
                    />
                  )}
                </ListToolbarEnd>
              </ListToolbar>

              <div className="pt-4">
                <BoneRegion id="list">
                  {!loading && shown.length === 0 ? (
                    <EmptyState
                      icon={<SearchX />}
                      title="No domain matches"
                      description={
                        q
                          ? `Nothing is called anything like “${query.trim()}”.`
                          : "No domain is in that state."
                      }
                      secondary={
                        <Button size="sm" variant="secondary" onClick={clear}>
                          Clear filters
                        </Button>
                      }
                    />
                  ) : (
                    <ListTable>
                      <ListHeader>
                        <th className="w-[4.25rem] py-2.5 pl-4">
                          <Bone
                            id="all"
                            shape="box"
                            width={36}
                            height={36}
                            inset={9}
                            radius={5}
                            inline
                          >
                            {!loading && selection.headerBox("Select all domains")}
                          </Bone>
                        </th>
                        <ListHead className="pl-0">Domain</ListHead>
                        {/* Wide enough for "Verified elsewhere" and "Temporary failure". F = 384 (tick 68, Status 160, Added 96, actions 60): Setup 144 -> 748 -> md (832); Region 96 -> 844 -> lg (928). */}
                        <ListHead className="w-[10rem]">Status</ListHead>
                        <ListHead hideBelow="md" className="w-[9rem]">
                          Setup
                        </ListHead>
                        <ListHead hideBelow="lg" className="w-[6rem]">
                          Region
                        </ListHead>
                        <ListHead className="w-[6rem] text-right">Added</ListHead>
                        <ListHead className="w-[3.75rem]">
                          <span className="sr-only">Actions</span>
                        </ListHead>
                      </ListHeader>
                      <Body>
                        {rows.map((d, i) => {
                          const ticked = d !== undefined && selection.isTicked(d)
                          return (
                            <BoneScope key={d?.id ?? i} id={`row-${i}`} unit>
                              <RowEl
                                {...(d
                                  ? {
                                      href: `/domains/${d.id}`,
                                      onMouseEnter: () =>
                                        seedShape(
                                          domainDetailShape,
                                          d.id,
                                          seedDomainShape(d),
                                        ),
                                      onFocus: () =>
                                        seedShape(
                                          domainDetailShape,
                                          d.id,
                                          seedDomainShape(d),
                                        ),
                                      onClick: () =>
                                        seedShape(
                                          domainDetailShape,
                                          d.id,
                                          seedDomainShape(d),
                                        ),
                                    }
                                  : {})}
                                clickable
                                className={cn(ticked && selectedRowClass)}
                              >
                                <td className="w-[4.25rem] py-3 pl-4">
                                  <Bone
                                    id="tick"
                                    shape="box"
                                    width={36}
                                    height={36}
                                    inset={9}
                                    radius={5}
                                    inline
                                  >
                                    {d && selection.rowBox(d, `Select ${d.name}`)}
                                  </Bone>
                                </td>
                                <ListCell className="pl-0">
                                  <div className="flex items-center gap-3">
                                    <ListTile>
                                      <Globe className="size-4" />
                                    </ListTile>
                                    <Bone
                                      id="name"
                                      width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                      className="min-w-0 flex-1"
                                    >
                                      {d && (
                                        <Link
                                          href={`/domains/${d.id}`}
                                          title={d.name}
                                          className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                                          onMouseEnter={() =>
                                            seedShape(
                                              domainDetailShape,
                                              d.id,
                                              seedDomainShape(d),
                                            )
                                          }
                                          onClick={() =>
                                            seedShape(
                                              domainDetailShape,
                                              d.id,
                                              seedDomainShape(d),
                                            )
                                          }
                                        >
                                          {d.name}
                                        </Link>
                                      )}
                                    </Bone>
                                    {d?.mailboxes?.enabled && (
                                      <Badge size="sm" tone="neutral">
                                        Mailboxes
                                      </Badge>
                                    )}
                                  </div>
                                </ListCell>
                                <ListCell>
                                  <Bone
                                    id="status"
                                    shape="box"
                                    width={76}
                                    height={20}
                                    radius={9999}
                                    inline
                                  >
                                    {d && <Status status={d.status} label={label(d)} />}
                                  </Bone>
                                </ListCell>
                                <ListCell hideBelow="md">
                                  <Bone
                                    id="setup"
                                    shape="box"
                                    width={96}
                                    height={26}
                                    radius={9999}
                                    inline
                                  >
                                    {d && (
                                      <Badge tone={d.delegated ? "info" : "neutral"}>
                                        {d.delegated ? "Delegated" : "Manual records"}
                                      </Badge>
                                    )}
                                  </Bone>
                                </ListCell>
                                <ListCell
                                  hideBelow="lg"
                                  className="font-mono text-xs text-muted-foreground"
                                >
                                  <Bone id="region" lineHeight={16} width={56}>
                                    {d?.region}
                                  </Bone>
                                </ListCell>
                                <ListCell
                                  className="text-right text-xs whitespace-nowrap text-muted-foreground"
                                  title={d?.created_at}
                                >
                                  <Bone
                                    id="added"
                                    lineHeight={16}
                                    width={64}
                                    align="end"
                                  >
                                    {d && <Time iso={d.created_at} />}
                                  </Bone>
                                </ListCell>
                                <ListCell className="py-1.5 text-right">
                                  {/* The row menu is skipped by test/skeleton-parity, so a skeleton draws nothing here. */}
                                  {d && (
                                    <DomainActions
                                      id={d.id}
                                      name={d.name}
                                      scopedKeys={scopedKeys[d.name] ?? []}
                                    />
                                  )}
                                </ListCell>
                              </RowEl>
                            </BoneScope>
                          )
                        })}
                      </Body>
                    </ListTable>
                  )}
                </BoneRegion>
              </div>
            </div>
          )}

          <BulkBar
            count={picked.length}
            onClear={clearSelection}
            label="Selected domains"
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={checking}
              onClick={() => void recheck()}
            >
              <RefreshCw className={cn(checking && "animate-spin")} />
              Re-check
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(picked.map((d) => d.name).join("\n"))
                  .then(
                    () =>
                      toastDone(
                        picked.length === 1
                          ? "Domain name copied"
                          : "Domain names copied",
                      ),
                    () => toastError("Could not copy the names"),
                  )
              }
            >
              <Copy />
              Copy names
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setDeletingDomains(picked)
                setDeleting(true)
              }}
            >
              <Trash2 />
              Delete
            </Button>
          </BulkBar>

          <DeleteDomainsDialog
            domains={deletingDomains.map((d) => ({
              id: d.id,
              name: d.name,
              scopedKeys: scopedKeys[d.name] ?? [],
            }))}
            open={deleting}
            onOpenChange={setDeleting}
            // The rows are gone behind the dialog; only the ticks are left to drop.
            onDeleted={clearSelection}
          />
        </PageBody>
        {data && data.error === undefined && (
          <RememberShape def={domainsShape} shape={shape} />
        )}
      </Page>
    </BoneScope>
  )
}
