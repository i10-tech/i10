"use client"

import * as React from "react"
import Link from "next/link"
import { Globe, SearchX } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { DomainActions } from "@/components/domain-actions"
import { EmptyState } from "@/components/empty-state"
import { ListCard, ListGrid, MotionBody, MotionRow } from "@/components/list/motion"
import { ListCell, ListHead, ListHeader, ListTable } from "@/components/list/table"
import {
  FilterSelect,
  ListToolbar,
  ResultsLine,
  SearchField,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import { Status, StatusDot, describeStatus } from "@/components/status"
import { formatRelative } from "@/lib/format"
import type { DomainSummary } from "@/lib/types"

/**
 * The domains, Resend's way: search, a status filter, a region filter, and a
 * grid or a table.
 *
 * ⚠ FILTERED IN THE BROWSER. A workspace has a handful of domains and the
 * API returns all of them; a round trip per keystroke would only add latency.
 *
 * ⚠ THE OPTIONS ARE THE VALUES PRESENT, so a filter never offers a status no
 * domain is in.
 */
export function DomainsList({
  domains,
  scopedKeys,
}: {
  domains: DomainSummary[]
  /** Per domain name, the live keys that can ONLY send from it. */
  scopedKeys: Record<string, { id: string; name: string }[]>
}) {
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("")
  const [region, setRegion] = React.useState("")
  const [view, setView] = useRememberedView("domains", "table")

  const statusOf = (d: DomainSummary) => (d.displaced_at ? "displaced" : d.status)
  const statuses = [...new Set(domains.map(statusOf))]
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

  const label = (d: DomainSummary) =>
    // ⚠ "FAILED" IS THE WRONG WORD FOR A DISPLACED DOMAIN. Nothing about its DNS
    // failed; another workspace proved it.
    d.displaced_at ? "Verified elsewhere" : undefined

  return (
    <div>
      <ListToolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search domains"
          label="Search domains"
        />
        {statuses.length > 1 && (
          <FilterSelect
            value={status}
            onValueChange={setStatus}
            label="Status"
            allLabel="All statuses"
            options={statuses.map((s) => {
              const described = describeStatus(s === "displaced" ? "failed" : s)
              return {
                value: s,
                label: s === "displaced" ? "Verified elsewhere" : described.label,
                icon: <StatusDot tone={described.tone} />,
              }
            })}
          />
        )}
        {regions.length > 1 && (
          <FilterSelect
            value={region}
            onValueChange={setRegion}
            label="Region"
            allLabel="All regions"
            options={regions.map((r) => ({ value: r, label: r }))}
          />
        )}
        <ViewToggle value={view} onChange={setView} />
      </ListToolbar>

      <ResultsLine
        count={shown.length}
        query={query}
        filtered={filtered}
        noun={["domain", "domains"]}
        onClear={clear}
      />

      <div className="pt-4">
        {shown.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="No domain matches"
            description={
              q
                ? `Nothing is called anything like “${query.trim()}”.`
                : "No domain is in that state."
            }
            secondary={
              <Button size="sm" variant="outline" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : view === "grid" ? (
          <ListGrid>
            {shown.map((d) => (
              <ListCard
                key={d.id}
                id={d.id}
                href={`/domains/${d.id}`}
                menu={
                  <DomainActions
                    id={d.id}
                    name={d.name}
                    scopedKeys={scopedKeys[d.name] ?? []}
                  />
                }
              >
                <div className="flex items-center gap-3 pr-8">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                    <Globe className="size-4" />
                  </span>
                  <p className="min-w-0 truncate font-medium">{d.name}</p>
                </div>
                <Status status={d.status} label={label(d)} />
                <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Badge variant={d.delegated ? "secondary" : "outline"}>
                      {d.delegated ? "Delegated" : "Manual records"}
                    </Badge>
                    <span className="font-mono">{d.region}</span>
                  </span>
                  <span title={d.created_at}>{formatRelative(d.created_at)}</span>
                </div>
              </ListCard>
            ))}
          </ListGrid>
        ) : (
          <ListTable>
            <ListHeader>
              <ListHead>Domain</ListHead>
              <ListHead className="w-[11rem]">Status</ListHead>
              <ListHead className="hidden w-[10rem] sm:table-cell">Setup</ListHead>
              <ListHead className="hidden w-[9rem] md:table-cell">Region</ListHead>
              <ListHead className="w-[9rem] text-right">Added</ListHead>
              <ListHead className="w-12">
                <span className="sr-only">Actions</span>
              </ListHead>
            </ListHeader>
            <MotionBody>
              {shown.map((d) => (
                <MotionRow key={d.id} href={`/domains/${d.id}`}>
                  <ListCell>
                    <Link
                      href={`/domains/${d.id}`}
                      className="font-medium outline-none hover:underline focus-visible:underline"
                    >
                      {d.name}
                    </Link>
                  </ListCell>
                  <ListCell>
                    <Status status={d.status} label={label(d)} />
                  </ListCell>
                  <ListCell className="hidden sm:table-cell">
                    <Badge variant={d.delegated ? "secondary" : "outline"}>
                      {d.delegated ? "Delegated" : "Manual records"}
                    </Badge>
                  </ListCell>
                  <ListCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                    {d.region}
                  </ListCell>
                  <ListCell
                    className="text-right text-xs whitespace-nowrap text-muted-foreground"
                    title={d.created_at}
                  >
                    {formatRelative(d.created_at)}
                  </ListCell>
                  <ListCell className="py-1.5 text-right">
                    <DomainActions
                      id={d.id}
                      name={d.name}
                      scopedKeys={scopedKeys[d.name] ?? []}
                    />
                  </ListCell>
                </MotionRow>
              ))}
            </MotionBody>
          </ListTable>
        )}
      </div>
    </div>
  )
}
